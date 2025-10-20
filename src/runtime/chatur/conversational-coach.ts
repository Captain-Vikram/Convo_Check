import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import { coachAgent } from "../../agents/coach.js";
import { getAgentConfig, createLanguageModel } from "../../config.js";
import type { HabitInsight } from "../param/analyst-agent.js";
import { getCircuitBreaker, withRetry, LLMError } from "../shared/error-handling.js";

/**
 * Conversational session with Coach for interactive guidance
 */
export interface CoachConversation {
  sessionId: string;
  startedAt: string;
  insights: HabitInsight[];
  messages: Array<{ role: "user" | "assistant"; content: string; timestamp: string }>;
  state: "active" | "completed" | "abandoned";
  currentQuestion?: string;
  collectedInfo: Record<string, unknown>;
}

export interface CoachConversationOptions {
  insights: HabitInsight[];
  initialQuestion?: string;
  maxTurns?: number;
}

export class ConversationalCoach {
  private activeSessions = new Map<string, CoachConversation>();
  private circuitBreaker = getCircuitBreaker("coach-llm", {
    failureThreshold: 3,
    timeout: 20_000,
  });

  /**
   * Start a new conversational session with the coach
   */
  startConversation(options: CoachConversationOptions): CoachConversation {
    const sessionId = randomUUID();
    const conversation: CoachConversation = {
      sessionId,
      startedAt: new Date().toISOString(),
      insights: options.insights,
      messages: [],
      state: "active",
      collectedInfo: {},
    };

    this.activeSessions.set(sessionId, conversation);

    // Start with initial question if provided
    if (options.initialQuestion) {
      conversation.currentQuestion = options.initialQuestion;
      conversation.messages.push({
        role: "assistant",
        content: options.initialQuestion,
        timestamp: new Date().toISOString(),
      });
    }

    return conversation;
  }

  /**
   * Continue a conversation with user response
   */
  async continueConversation(
    sessionId: string,
    userResponse: string,
  ): Promise<{
    message: string;
    completed: boolean;
    guidance?: CoachGuidance;
    shouldEscalateToMill?: boolean;
  }> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Conversation ${sessionId} not found`);
    }

    if (session.state !== "active") {
      throw new Error(`Conversation ${sessionId} is ${session.state}`);
    }

    // Add user message
    session.messages.push({
      role: "user",
      content: userResponse,
      timestamp: new Date().toISOString(),
    });

    // Generate coach response using LLM
    const result = await this.generateCoachResponse(session);

    // Check if should escalate to Mill
    if (result.shouldEscalateToMill) {
      session.state = "completed";
      return {
        message:
          result.message +
          " Let me connect you with Mill who can help you log that transaction. 📝",
        completed: true,
        shouldEscalateToMill: true,
      };
    }

    // Add assistant message
    session.messages.push({
      role: "assistant",
      content: result.message,
      timestamp: new Date().toISOString(),
    });

    // Update collected info if provided
    if (result.extractedInfo) {
      Object.assign(session.collectedInfo, result.extractedInfo);
    }

    // Check if conversation is complete
    if (result.completed) {
      session.state = "completed";
      const guidance = await this.generateFinalGuidance(session);
      return { message: result.message, completed: true, guidance };
    }

    // Update current question
    if (result.nextQuestion) {
      session.currentQuestion = result.nextQuestion;
    }

    return { message: result.message, completed: false };
  }

  /**
   * Get active conversation
   */
  getConversation(sessionId: string): CoachConversation | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * End a conversation
   */
  endConversation(sessionId: string, state: "completed" | "abandoned" = "abandoned"): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.state = state;
    }
  }

  /**
   * Clean up old sessions (memory management)
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
   * Generate coach response using LLM with error handling
   */
  private async generateCoachResponse(
    session: CoachConversation,
  ): Promise<{
    message: string;
    completed: boolean;
    nextQuestion?: string;
    extractedInfo?: Record<string, unknown>;
    shouldEscalateToMill?: boolean;
  }> {
    const prompt = this.buildConversationalPrompt(session);

    try {
      return await this.circuitBreaker.execute(
        async () => {
          return withRetry(
            async () => {
              const config = getAgentConfig("agent4");
              const languageModel = createLanguageModel(config);

              const result = await generateText({
                model: languageModel,
                messages: [
                  { role: "system", content: this.getConversationalSystemPrompt() },
                  { role: "user", content: prompt },
                ],
              });

              const text = (result.text ?? "").trim();
              return this.parseConversationalResponse(text);
            },
            { maxAttempts: 3 },
            (error: unknown) => {
              // Only retry on network/timeout errors
              return !(error instanceof LLMError);
            },
          );
        },
        async () => {
          // Fallback to rule-based response
          return this.fallbackResponse(session);
        },
      );
    } catch (error) {
      console.error("[coach] Failed to generate conversational response", error);
      return this.fallbackResponse(session);
    }
  }

  private getConversationalSystemPrompt(): string {
    return `${coachAgent.systemPrompt}

You are Chatur in CONVERSATIONAL mode. Your specialized role:
- Provide personalized financial advice and coaching
- Help users set and achieve financial goals
- Offer motivational support and habit improvement strategies
- Tailor guidance for gig workers and irregular income scenarios

UNDERSTAND YOUR ROLE VS MILL:
- **You (Chatur)**: Financial advice, budgeting tips, goal setting, motivation, "what should I do"
- **Mill**: Transaction logging, data queries, coordination
- If user asks to log transactions or check spending data → suggest they talk to Mill
- Focus on: advice, guidance, planning, goals, habits, motivation

CONVERSATIONAL STRATEGY:
1. Ask clarifying questions about goals, challenges, priorities
2. Gather context: income patterns, spending habits, constraints
3. Extract information: goals (save/reduce spending), problem areas, timeline
4. After 2-4 turns, provide personalized action plan
5. Keep responses concise (2-3 sentences), encouraging, practical
6. Use evidence from insights to ground advice

Respond with JSON:
{
  "message": "Your supportive, actionable response to user",
  "completed": true/false,
  "nextQuestion": "Follow-up question if not completed",
  "extractedInfo": {
    "primaryGoal": "save|reduce_spending|increase_income|other",
    "problemArea": "food|entertainment|impulse|irregular_income",
    "timeline": "immediate|1month|3months|longterm",
    "constraints": "budget_amount|time|knowledge"
  },
  "shouldEscalateToMill": false // Set true if user asks to log transactions
}

KEY RULES:
- If user says "log this" or "I spent X" → set shouldEscalateToMill: true
- Focus on WHY and HOW, not just WHAT (that's Mill's job)
- Use insights to personalize advice
- Be optimistic but realistic for gig worker context`;
  }

  private buildConversationalPrompt(session: CoachConversation): string {
    const lines: string[] = [];

    lines.push("Latest financial insights:");
    session.insights.forEach((insight, idx) => {
      lines.push(`${idx + 1}. ${insight.fullText}`);
    });

    lines.push("\nConversation so far:");
    session.messages.forEach((msg) => {
      lines.push(`${msg.role === "user" ? "User" : "Coach"}: ${msg.content}`);
    });

    lines.push("\nCollected information:");
    lines.push(JSON.stringify(session.collectedInfo, null, 2));

    lines.push("\nGenerate your next response.");
    return lines.join("\n");
  }

  private parseConversationalResponse(text: string): {
    message: string;
    completed: boolean;
    nextQuestion?: string;
    extractedInfo?: Record<string, unknown>;
    shouldEscalateToMill?: boolean;
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
        completed: parsed.completed ?? false,
        nextQuestion: parsed.nextQuestion,
        extractedInfo: parsed.extractedInfo,
        shouldEscalateToMill: parsed.shouldEscalateToMill ?? false,
      };
    } catch {
      // Fallback: treat entire text as message
      return { message: text, completed: false };
    }
  }

  private fallbackResponse(session: CoachConversation): {
    message: string;
    completed: boolean;
    nextQuestion?: string;
  } {
    const turnCount = session.messages.filter((m) => m.role === "user").length;

    if (turnCount === 0) {
      return {
        message: "Let me understand your financial goals better. What's your biggest priority right now - saving more, reducing expenses, or something else?",
        completed: false,
        nextQuestion: "What's your financial priority?",
      };
    }

    if (turnCount < 3) {
      return {
        message: "Thanks for sharing that! Based on your insights, I see some patterns. What would you like to focus on improving first?",
        completed: false,
        nextQuestion: "What area to improve?",
      };
    }

    // Complete after 3+ turns
    return {
      message: "Based on what you've shared, here's my advice: Focus on tracking your spending patterns and set a realistic budget. Start small and build consistent habits. You're on the right track!",
      completed: true,
    };
  }

  private async generateFinalGuidance(session: CoachConversation): Promise<CoachGuidance> {
    // Generate comprehensive guidance based on conversation
    const summary = session.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" | ");

    return {
      headline: "Personalized Plan",
      counsel: `Based on our conversation: ${summary.slice(0, 100)}`,
      evidence: session.insights[0]?.evidence ?? "Conversation-based",
      conversationSummary: summary,
    };
  }
}

export interface CoachGuidance {
  headline: string;
  counsel: string;
  evidence: string;
  conversationSummary?: string;
}
