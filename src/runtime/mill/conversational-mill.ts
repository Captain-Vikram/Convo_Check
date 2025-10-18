import { randomUUID } from "node:crypto";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { chatbotAgent } from "../../agents/chatbot.js";
import { getAgentConfig } from "../../config.js";
import { getCircuitBreaker, withRetry, LLMError } from "../shared/error-handling.js";
import type { LogCashTransactionPayload } from "../../tools/log-cash-transaction.js";
import type { SpendingSummaryResult } from "../../tools/query-spending-summary.js";

/**
 * Mill's conversational session for transaction logging and financial queries
 * Mill specializes in: transaction logging, data retrieval, coordinating other agents
 */
export interface MillConversation {
  sessionId: string;
  startedAt: string;
  messages: Array<{ role: "user" | "assistant"; content: string; timestamp: string }>;
  state: "active" | "completed" | "abandoned";
  intent: "logging" | "query" | "general" | "unclear";
  collectedInfo: {
    transactionAmount?: number;
    transactionDescription?: string;
    transactionCategory?: string;
    transactionDirection?: "expense" | "income";
    queryType?: "summary" | "recent" | "category" | "specific";
  };
  pendingAction?: "log_transaction" | "query_data" | "escalate_to_coach";
}

export interface MillConversationOptions {
  initialMessage?: string;
  maxTurns?: number;
  onTransactionReady?: (payload: LogCashTransactionPayload) => Promise<void>;
  onQueryReady?: () => Promise<SpendingSummaryResult>;
}

export class ConversationalMill {
  private activeSessions = new Map<string, MillConversation>();
  private circuitBreaker = getCircuitBreaker("mill-llm", {
    failureThreshold: 3,
    timeout: 20_000,
  });

  /**
   * Start a conversation with Mill for transaction/query handling
   */
  startConversation(options: MillConversationOptions = {}): MillConversation {
    const sessionId = randomUUID();
    const conversation: MillConversation = {
      sessionId,
      startedAt: new Date().toISOString(),
      messages: [],
      state: "active",
      intent: "unclear",
      collectedInfo: {},
    };

    this.activeSessions.set(sessionId, conversation);

    if (options.initialMessage) {
      conversation.messages.push({
        role: "assistant",
        content: options.initialMessage,
        timestamp: new Date().toISOString(),
      });
    }

    return conversation;
  }

  /**
   * Continue conversation with Mill
   */
  async continueConversation(
    sessionId: string,
    userMessage: string,
    options: MillConversationOptions = {},
  ): Promise<{
    message: string;
    completed: boolean;
    action?: "transaction_logged" | "data_retrieved" | "escalate_to_coach";
    payload?: LogCashTransactionPayload | SpendingSummaryResult | { reason: string };
  }> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Mill conversation ${sessionId} not found`);
    }

    if (session.state !== "active") {
      throw new Error(`Mill conversation ${sessionId} is ${session.state}`);
    }

    // Add user message
    session.messages.push({
      role: "user",
      content: userMessage,
      timestamp: new Date().toISOString(),
    });

    // Generate Mill's response using LLM
    const result = await this.generateMillResponse(session);

    // Add assistant message
    session.messages.push({
      role: "assistant",
      content: result.message,
      timestamp: new Date().toISOString(),
    });

    // Update collected info
    if (result.extractedInfo) {
      Object.assign(session.collectedInfo, result.extractedInfo);
    }

    // Update intent
    if (result.intent) {
      session.intent = result.intent;
    }

    // Check if we should execute an action
    if (result.action === "log_transaction" && this.hasCompleteTransaction(session)) {
      const payload = this.buildTransactionPayload(session, userMessage);
      if (options.onTransactionReady) {
        await options.onTransactionReady(payload);
      }
      session.state = "completed";
      return {
        message: result.message,
        completed: true,
        action: "transaction_logged",
        payload,
      };
    }

    if (result.action === "query_data") {
      if (options.onQueryReady) {
        const queryResult = await options.onQueryReady();
        session.state = "completed";
        return {
          message: result.message,
          completed: true,
          action: "data_retrieved",
          payload: queryResult,
        };
      }
    }

    if (result.action === "escalate_to_coach") {
      session.state = "completed";
      return {
        message: result.message,
        completed: true,
        action: "escalate_to_coach",
        payload: { reason: result.escalationReason || "User needs financial advice" },
      };
    }

    // Update pending action
    if (result.action) {
      session.pendingAction = result.action;
    }

    return { message: result.message, completed: false };
  }

  /**
   * Get active conversation
   */
  getConversation(sessionId: string): MillConversation | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * End conversation
   */
  endConversation(sessionId: string, state: "completed" | "abandoned" = "abandoned"): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.state = state;
    }
  }

  /**
   * Clean up old sessions
   */
  cleanupOldSessions(maxAgeMs = 3600_000): void {
    const now = Date.now();
    for (const [sessionId, session] of this.activeSessions.entries()) {
      const age = now - Date.parse(session.startedAt);
      if (age > maxAgeMs && session.state !== "active") {
        this.activeSessions.delete(sessionId);
      }
    }
  }

  /**
   * Generate Mill's response using LLM with specialized understanding
   */
  private async generateMillResponse(
    session: MillConversation,
  ): Promise<{
    message: string;
    intent?: "logging" | "query" | "general" | "unclear";
    action?: "log_transaction" | "query_data" | "escalate_to_coach";
    extractedInfo?: Partial<MillConversation["collectedInfo"]>;
    escalationReason?: string;
  }> {
    const prompt = this.buildMillPrompt(session);

    try {
      return await this.circuitBreaker.execute(
        async () => {
          return withRetry(
            async () => {
              const { apiKey, model } = getAgentConfig("agent1");
              const provider = createGoogleGenerativeAI({ apiKey });
              const languageModel = provider(model);

              const result = await generateText({
                model: languageModel,
                messages: [
                  { role: "system", content: this.getMillSystemPrompt() },
                  { role: "user", content: prompt },
                ],
              });

              const text = (result.text ?? "").trim();
              return this.parseMillResponse(text);
            },
            { maxAttempts: 3 },
          );
        },
        async () => this.fallbackMillResponse(session),
      );
    } catch (error) {
      console.error("[mill] Failed to generate conversational response", error);
      return this.fallbackMillResponse(session);
    }
  }

  private getMillSystemPrompt(): string {
    return `${chatbotAgent.systemPrompt}

You are Mill in CONVERSATIONAL mode. Your specialized role:
- Log transactions (expenses and income)
- Query financial data (summaries, recent transactions)
- Coordinate with other agents (Dev for data, Param for analysis, Chatur for advice)

UNDERSTAND USER INTENT:
1. **Transaction Logging**: User mentions spending/earning money, amounts, purchases
   - Ask clarifying questions: amount, what it was for, category
   - Once complete, execute log_transaction action
   
2. **Data Queries**: User asks about spending, history, transactions, summaries
   - Execute query_data action immediately
   - Present results in friendly, conversational way
   
3. **Financial Advice**: User asks for tips, advice, guidance, "what should I do"
   - Recognize this is Chatur's specialty, not yours
   - Escalate with: "Let me connect you with Chatur, our financial coach"
   - Action: escalate_to_coach

4. **General Chat**: Greetings, clarifications, follow-ups
   - Be friendly and guide toward your capabilities

RESPONSE FORMAT (JSON):
{
  "message": "Your friendly response to user (2-3 sentences max)",
  "intent": "logging|query|general|unclear",
  "action": "log_transaction|query_data|escalate_to_coach|null",
  "extractedInfo": {
    "transactionAmount": 500,
    "transactionDescription": "groceries",
    "transactionCategory": "Food & Groceries",
    "transactionDirection": "expense",
    "queryType": "summary|recent|category"
  },
  "escalationReason": "User needs personalized financial advice"
}

KEY RULES:
- If user asks for advice/tips/guidance → escalate_to_coach (don't try to give advice yourself)
- If user mentions amount/purchase → intent is "logging"
- If user asks "how much" or "show me" → intent is "query"
- Be concise, friendly, use emojis
- Don't overlap with Chatur's role (financial coaching/advice)`;
  }

  private buildMillPrompt(session: MillConversation): string {
    const lines: string[] = [];

    lines.push("Conversation so far:");
    session.messages.forEach((msg) => {
      lines.push(`${msg.role === "user" ? "User" : "Mill"}: ${msg.content}`);
    });

    lines.push("\nCollected information:");
    lines.push(JSON.stringify(session.collectedInfo, null, 2));

    lines.push(`\nCurrent intent: ${session.intent}`);
    lines.push(`Pending action: ${session.pendingAction || "none"}`);

    lines.push("\nGenerate your next response. Determine intent and action needed.");
    return lines.join("\n");
  }

  private parseMillResponse(text: string): {
    message: string;
    intent?: "logging" | "query" | "general" | "unclear";
    action?: "log_transaction" | "query_data" | "escalate_to_coach";
    extractedInfo?: Partial<MillConversation["collectedInfo"]>;
    escalationReason?: string;
  } {
    try {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const jsonText = jsonMatch ? jsonMatch[1]!.trim() : text;

      const startIdx = jsonText.indexOf("{");
      const endIdx = jsonText.lastIndexOf("}");
      if (startIdx === -1 || endIdx === -1) {
        throw new Error("No JSON found");
      }

      const parsed = JSON.parse(jsonText.slice(startIdx, endIdx + 1));
      return {
        message: parsed.message ?? text,
        intent: parsed.intent,
        action: parsed.action === "null" ? undefined : parsed.action,
        extractedInfo: parsed.extractedInfo,
        escalationReason: parsed.escalationReason,
      };
    } catch {
      return { message: text };
    }
  }

  private fallbackMillResponse(session: MillConversation): {
    message: string;
    intent: "logging" | "query" | "general" | "unclear";
    action?: "log_transaction" | "query_data" | "escalate_to_coach";
  } {
    const lastUserMsg = session.messages
      .filter((m) => m.role === "user")
      .slice(-1)[0]?.content.toLowerCase() || "";

    // Detect advice seeking
    if (
      lastUserMsg.includes("advice") ||
      lastUserMsg.includes("should i") ||
      lastUserMsg.includes("help me") ||
      lastUserMsg.includes("tip")
    ) {
      return {
        message:
          "Great question! Let me connect you with Chatur, our financial coach who specializes in personalized advice. 💡",
        intent: "general",
        action: "escalate_to_coach",
      };
    }

    // Detect query intent
    if (
      lastUserMsg.includes("how much") ||
      lastUserMsg.includes("show") ||
      lastUserMsg.includes("spent") ||
      lastUserMsg.includes("history")
    ) {
      return {
        message: "Let me fetch your spending data for you! 📊",
        intent: "query",
        action: "query_data",
      };
    }

    // Detect logging intent
    if (/\d+/.test(lastUserMsg) || lastUserMsg.includes("spent") || lastUserMsg.includes("paid")) {
      return {
        message: "Got it! Could you tell me the amount and what it was for? 💸",
        intent: "logging",
      };
    }

    return {
      message:
        "I can help you log transactions or check your spending. What would you like to do? 😊",
      intent: "unclear",
    };
  }

  private hasCompleteTransaction(session: MillConversation): boolean {
    return !!(
      session.collectedInfo.transactionAmount &&
      session.collectedInfo.transactionDescription &&
      session.collectedInfo.transactionDirection
    );
  }

  private buildTransactionPayload(
    session: MillConversation,
    rawText: string,
  ): LogCashTransactionPayload {
    return {
      amount: session.collectedInfo.transactionAmount!,
      description: session.collectedInfo.transactionDescription!,
      category_suggestion: session.collectedInfo.transactionCategory || "Other",
      direction: session.collectedInfo.transactionDirection!,
      raw_text: rawText,
    };
  }
}
