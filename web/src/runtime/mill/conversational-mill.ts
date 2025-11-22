import { randomUUID } from "node:crypto";
import { chatbotAgent } from "@/agents/chatbot";
import { getCircuitBreaker, withRetry } from "../shared/error-handling";
import { BaseConversationalAgent, type ConversationSession, type ConversationOptions } from "../shared/base-agent";
import type { CoreMessage } from "ai";
import type { AgentInput } from "../shared/multimodal";
import { normalizeAgentInput, summarizeInputForHistory, buildMultimodalContent } from "../shared/multimodal";
import type { LogCashTransactionPayload } from "@/tools/log-cash-transaction";
import type { SpendingSummaryResult } from "@/tools/query-spending-summary";
import { createFinancialCalculatorTool } from "@/tools/financial-calculator";

/**
 * Mill's conversational session for transaction logging and financial queries
 * Mill specializes in: transaction logging, data retrieval, coordinating other agents
 */
export interface MillConversation extends ConversationSession<{
  transactionAmount?: number;
  transactionDescription?: string;
  transactionCategory?: string;
  transactionType?: "debit" | "credit";
  queryType?: "summary" | "recent" | "category" | "specific";
}> {
  intent: "logging" | "query" | "general" | "unclear";
  pendingAction?: "log_transaction" | "query_data" | "escalate_to_coach";
}

export interface MillConversationOptions extends ConversationOptions {
  onTransactionReady?: (payload: LogCashTransactionPayload) => Promise<void>;
  onQueryReady?: () => Promise<SpendingSummaryResult>;
}

export class ConversationalMill extends BaseConversationalAgent<MillConversation> {
  private circuitBreaker = getCircuitBreaker("mill-llm", {
    failureThreshold: 3,
    timeout: 20_000,
  });

  constructor() {
    super({
      agentId: "agent1",
      systemPrompt: chatbotAgent.systemPrompt,
      temperature: 0.7,
      maxTokens: 2000,
      maxSessionAgeMs: 3600_000,
    });
  }

  /**
   * Create a new Mill conversation session
   */
  protected createSession(sessionId: string, options: ConversationOptions): MillConversation {
    return {
      sessionId,
      startedAt: new Date().toISOString(),
      messages: [],
      state: "active",
      intent: "unclear",
      collectedInfo: {},
    };
  }

  /**
   * Continue conversation with Mill
   */
  async continueConversation(
    sessionId: string,
    userMessage: string | AgentInput,
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

    const normalizedInput = normalizeAgentInput(userMessage);
    const summarized = summarizeInputForHistory(normalizedInput);

    const userEntry: MillConversation["messages"][number] = {
      role: "user",
      content: summarized,
      timestamp: new Date().toISOString(),
    };

    if (normalizedInput.attachments && normalizedInput.attachments.length > 0) {
      userEntry.attachments = normalizedInput.attachments;
    }

    session.messages.push(userEntry);

    // Generate Mill's response using LLM
    const result = await this.generateMillResponse(session, normalizedInput);

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
      const payload = this.buildTransactionPayload(session, normalizedInput.text);
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
   * Generate Mill's response using LLM with specialized understanding
   */
  private async generateMillResponse(
    session: MillConversation,
    latestInput?: AgentInput,
  ): Promise<{
    message: string;
    intent?: "logging" | "query" | "general" | "unclear";
    action?: "log_transaction" | "query_data" | "escalate_to_coach";
    extractedInfo?: Partial<MillConversation["collectedInfo"]>;
    escalationReason?: string;
  }> {
    const prompt = this.buildMillPrompt(session);
    const messages: any[] = [
      { role: "system", content: this.getMillSystemPrompt() },
      { role: "user", content: prompt },
    ];

    if (latestInput) {
      messages.push({
        role: "user",
        content: buildMultimodalContent(latestInput),
      });
    }

    try {
      return await this.circuitBreaker.execute(
        async () => {
          return withRetry(
            async () => {
              const result = await this.callLLM({
                messages: messages as CoreMessage[],
              });

              const text = (result.text ?? "").trim();
              console.log("[Mill] LLM Response:", text); // Debug log

              if (!text) {
                throw new Error("Empty response from LLM");
              }

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
    return `You are "Mill", the user's personal finance sidekick. You are charismatic, encouraging, and naturally funny.
    
You are in CONVERSATIONAL mode. Your specialized role:
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
You must output a valid JSON object. Do not use tool calls.
{
  "message": "Your friendly response to user (2-3 sentences max)",
  "intent": "logging|query|general|unclear",
  "action": "log_transaction|query_data|escalate_to_coach|null",
  "extractedInfo": {
    "transactionAmount": 500,
    "transactionDescription": "groceries",
    "transactionCategory": "Food & Groceries",
    "transactionType": "debit",
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
      lastUserMsg.includes("tip") ||
      lastUserMsg.includes("save") ||
      lastUserMsg.includes("budget") ||
      lastUserMsg.includes("reduce") ||
      lastUserMsg.includes("invest") ||
      lastUserMsg.includes("goal")
    ) {
      return {
        message:
          "Great question! Let me connect you with Chatur, our financial coach who specializes in personalized advice. 💡",
        intent: "general",
        action: "escalate_to_coach",
      };
    }

    // Detect logging intent (prioritize over query if amount is present)
    if (/\d+/.test(lastUserMsg) && (lastUserMsg.includes("spent") || lastUserMsg.includes("spend") || lastUserMsg.includes("paid") || lastUserMsg.includes("bought"))) {
      return {
        message: "Got it! Could you tell me the amount and what it was for? 💸",
        intent: "logging",
        action: "log_transaction",
      };
    }

    // Detect query intent
    if (
      lastUserMsg.includes("how much") ||
      lastUserMsg.includes("show") ||
      lastUserMsg.includes("history") ||
      ((lastUserMsg.includes("spent") || lastUserMsg.includes("spend")) && !/\d+/.test(lastUserMsg)) // "spent" or "spend" without number -> query
    ) {
      return {
        message: "Let me fetch your spending data for you! 📊",
        intent: "query",
        action: "query_data",
      };
    }

    // Default fallback
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
      session.collectedInfo.transactionType
    );
  }

  private buildTransactionPayload(
    session: MillConversation,
    rawText: string,
  ): LogCashTransactionPayload {
    const description = session.collectedInfo.transactionDescription!;
    const resolvedType = this.resolveTransactionType(
      session.collectedInfo.transactionType,
      description,
      rawText,
      session.collectedInfo.transactionCategory,
    );

    return {
      amount: session.collectedInfo.transactionAmount!,
      description,
      category_suggestion: session.collectedInfo.transactionCategory || "Other",
      type: resolvedType,
      raw_text: rawText,
    };
  }

  private resolveTransactionType(
    candidate: MillConversation["collectedInfo"]["transactionType"],
    description: string,
    rawText: string,
    category?: string,
  ): "debit" | "credit" {
    if (candidate === "credit") {
      return "credit";
    }

    const text = `${rawText} ${description} ${category ?? ""}`.toLowerCase();
    const incomeKeywords = [
      "received",
      "got",
      "earned",
      "income",
      "salary",
      "deposit",
      "credited",
      "payout",
      "refund",
      "reimbursement",
      "bonus",
      "payment from",
      "paid me",
    ];
    const expenseKeywords = [
      "spent",
      "paid",
      "bought",
      "purchase",
      "debit",
      "charged",
      "bill",
      "transfer to",
    ];

    const hasIncomeSignal = incomeKeywords.some((keyword) => text.includes(keyword));
    const hasExpenseSignal = expenseKeywords.some((keyword) => text.includes(keyword));

    const incomeCategoryHints = [
      "salary",
      "income",
      "side hustle",
      "bonus",
      "refund",
      "reimbursement",
      "cashback",
      "interest",
      "payout",
    ];
    const categoryLooksIncome = category
      ? incomeCategoryHints.some((hint) => category.toLowerCase().includes(hint))
      : false;

    const baseType = candidate ?? "debit";

    if (categoryLooksIncome || (hasIncomeSignal && !hasExpenseSignal)) {
      return "credit";
    }

    if (hasExpenseSignal && !hasIncomeSignal) {
      return "debit";
    }

    if (hasIncomeSignal && baseType === "debit") {
      return "credit";
    }

    return baseType;
  }
}
