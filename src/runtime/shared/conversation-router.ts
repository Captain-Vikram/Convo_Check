import { ConversationalMill, type MillConversation } from "../mill/conversational-mill.js";
import { ConversationalCoach, type CoachConversation } from "../chatur/conversational-coach.js";
import type { HabitInsight } from "../param/analyst-agent.js";
import type { LogCashTransactionPayload } from "../../tools/log-cash-transaction.js";
import type { SpendingSummaryResult } from "../../tools/query-spending-summary.js";

/**
 * Intelligent conversation router that understands when to use Mill vs Chatur
 * 
 * MILL specializes in:
 * - Logging transactions (expenses/income)
 * - Querying financial data
 * - Coordinating agents
 * 
 * CHATUR specializes in:
 * - Financial advice and coaching
 * - Goal setting and planning
 * - Habit improvement strategies
 * - Motivational support
 */

export type ActiveAgent = "mill" | "chatur" | "none";

export interface ConversationContext {
  activeAgent: ActiveAgent;
  millSessionId?: string;
  chaturSessionId?: string;
  conversationHistory: Array<{
    agent: ActiveAgent;
    userMessage: string;
    agentResponse: string;
    timestamp: string;
  }>;
}

export interface ConversationRouterOptions {
  onTransactionReady?: (payload: LogCashTransactionPayload) => Promise<void>;
  onQueryReady?: () => Promise<SpendingSummaryResult>;
  onInsightsAvailable?: () => Promise<HabitInsight[]>;
}

export class ConversationRouter {
  private mill: ConversationalMill;
  private chatur: ConversationalCoach;
  private contexts = new Map<string, ConversationContext>();

  constructor() {
    this.mill = new ConversationalMill();
    this.chatur = new ConversationalCoach();
  }

  /**
   * Start a new conversation - intelligently route based on first message
   */
  async startConversation(
    userId: string,
    firstMessage: string,
    options: ConversationRouterOptions = {},
  ): Promise<{ agent: ActiveAgent; message: string; sessionId: string }> {
    // Determine which agent should handle this
    const agent = this.routeInitialMessage(firstMessage);

    const context: ConversationContext = {
      activeAgent: agent,
      conversationHistory: [],
    };

    if (agent === "mill") {
      const millSession = this.mill.startConversation({
        initialMessage: "Hey! 👋 What's up? I can help you log transactions or check your spending.",
      });
      context.millSessionId = millSession.sessionId;
      context.conversationHistory.push({
        agent: "mill",
        userMessage: firstMessage,
        agentResponse: millSession.messages[0]?.content || "",
        timestamp: new Date().toISOString(),
      });

      this.contexts.set(userId, context);

      return {
        agent: "mill",
        message: millSession.messages[0]?.content || "",
        sessionId: millSession.sessionId,
      };
    } else if (agent === "chatur") {
      const insights = options.onInsightsAvailable ? await options.onInsightsAvailable() : [];
      const chaturSession = this.chatur.startConversation({
        insights,
        initialQuestion:
          "Hey there! 💡 I'm Chatur, your financial coach. I'd love to help you with your money goals. What's your biggest financial challenge or goal right now?",
      });
      context.chaturSessionId = chaturSession.sessionId;
      context.conversationHistory.push({
        agent: "chatur",
        userMessage: firstMessage,
        agentResponse: chaturSession.currentQuestion || "",
        timestamp: new Date().toISOString(),
      });

      this.contexts.set(userId, context);

      return {
        agent: "chatur",
        message: chaturSession.currentQuestion || "",
        sessionId: chaturSession.sessionId,
      };
    }

    // Default: ask what they want to do
    return {
      agent: "none",
      message:
        "Hey! 👋 I can help you:\n• Log transactions (Mill)\n• Get financial advice (Chatur)\n\nWhat would you like to do?",
      sessionId: "welcome",
    };
  }

  /**
   * Continue conversation with the appropriate agent
   */
  async continueConversation(
    userId: string,
    userMessage: string,
    options: ConversationRouterOptions = {},
  ): Promise<{
    agent: ActiveAgent;
    message: string;
    completed: boolean;
    switched?: boolean;
    newAgent?: ActiveAgent;
    result?: unknown;
  }> {
    const context = this.contexts.get(userId);
    if (!context) {
      // Start new conversation
      const startResult = await this.startConversation(userId, userMessage, options);
      return { ...startResult, completed: false };
    }

    const { activeAgent } = context;

    // Route to Mill
    if (activeAgent === "mill" && context.millSessionId) {
      const result = await this.mill.continueConversation(
        context.millSessionId,
        userMessage,
        options,
      );

      // Check if Mill wants to escalate to Chatur
      if (result.action === "escalate_to_coach") {
        const insights = options.onInsightsAvailable ? await options.onInsightsAvailable() : [];
        const chaturSession = this.chatur.startConversation({
          insights,
          initialQuestion:
            "Perfect! I'm Chatur, your financial coach. Let's work on your financial goals. " +
            result.message,
        });
        context.activeAgent = "chatur";
        context.chaturSessionId = chaturSession.sessionId;

        return {
          agent: "chatur",
          message: chaturSession.currentQuestion || "",
          completed: false,
          switched: true,
          newAgent: "chatur",
        };
      }

      context.conversationHistory.push({
        agent: "mill",
        userMessage,
        agentResponse: result.message,
        timestamp: new Date().toISOString(),
      });

      return {
        agent: "mill",
        message: result.message,
        completed: result.completed,
        result: result.payload,
      };
    }

    // Route to Chatur
    if (activeAgent === "chatur" && context.chaturSessionId) {
      const result = await this.chatur.continueConversation(context.chaturSessionId, userMessage);

      // Check if Chatur wants to escalate to Mill
      if (result.shouldEscalateToMill) {
        const millSession = this.mill.startConversation({
          initialMessage: "Sure thing! Let me help you log that. What's the amount and description?",
        });
        context.activeAgent = "mill";
        context.millSessionId = millSession.sessionId;

        return {
          agent: "mill",
          message: millSession.messages[0]?.content || "",
          completed: false,
          switched: true,
          newAgent: "mill",
        };
      }

      context.conversationHistory.push({
        agent: "chatur",
        userMessage,
        agentResponse: result.message,
        timestamp: new Date().toISOString(),
      });

      return {
        agent: "chatur",
        message: result.message,
        completed: result.completed,
        result: result.guidance,
      };
    }

    // No active agent - route based on message
    const startResult = await this.startConversation(userId, userMessage, options);
    return { ...startResult, completed: false };
  }

  /**
   * Get current conversation context
   */
  getContext(userId: string): ConversationContext | undefined {
    return this.contexts.get(userId);
  }

  /**
   * End conversation and cleanup
   */
  endConversation(userId: string): void {
    const context = this.contexts.get(userId);
    if (context) {
      if (context.millSessionId) {
        this.mill.endConversation(context.millSessionId, "completed");
      }
      if (context.chaturSessionId) {
        this.chatur.endConversation(context.chaturSessionId, "completed");
      }
      this.contexts.delete(userId);
    }
  }

  /**
   * Cleanup old conversations
   */
  cleanup(maxAgeMs = 3600_000): void {
    this.mill.cleanupOldSessions(maxAgeMs);
    this.chatur.cleanupOldSessions(maxAgeMs);
  }

  /**
   * Intelligently route initial message to appropriate agent
   */
  private routeInitialMessage(message: string): ActiveAgent {
    const lower = message.toLowerCase();

    // Keywords for Mill (transaction logging and data queries)
    const millKeywords = [
      "spent",
      "paid",
      "bought",
      "earned",
      "received",
      "income",
      "salary",
      "log",
      "record",
      "add transaction",
      "show me",
      "how much",
      "total",
      "history",
      "transactions",
      "recent",
      "last",
    ];

    // Keywords for Chatur (advice and coaching)
    const chaturKeywords = [
      "advice",
      "tip",
      "help me",
      "should i",
      "what to do",
      "goal",
      "save",
      "budget",
      "plan",
      "reduce",
      "improve",
      "habit",
      "coach",
      "guidance",
      "strategy",
    ];

    // Check for Mill keywords
    const millScore = millKeywords.filter((kw) => lower.includes(kw)).length;

    // Check for Chatur keywords
    const chaturScore = chaturKeywords.filter((kw) => lower.includes(kw)).length;

    // Check for amounts (indicates transaction logging - Mill's domain)
    const hasAmount = /\d+/.test(message);
    if (hasAmount) {
      return "mill";
    }

    // Route based on keyword score
    if (millScore > chaturScore) {
      return "mill";
    } else if (chaturScore > millScore) {
      return "chatur";
    }

    // Default to none (let user choose)
    return "none";
  }

  /**
   * Get conversation summary for the user
   */
  getConversationSummary(userId: string): string {
    const context = this.contexts.get(userId);
    if (!context || context.conversationHistory.length === 0) {
      return "No conversation history.";
    }

    const lines: string[] = [];
    lines.push(`Active Agent: ${context.activeAgent}`);
    lines.push(`\nConversation History (${context.conversationHistory.length} turns):\n`);

    context.conversationHistory.slice(-5).forEach((turn, idx) => {
      lines.push(`${idx + 1}. [${turn.agent.toUpperCase()}]`);
      lines.push(`   You: ${turn.userMessage.slice(0, 60)}...`);
      lines.push(`   ${turn.agent === "mill" ? "Mill" : "Chatur"}: ${turn.agentResponse.slice(0, 60)}...`);
    });

    return lines.join("\n");
  }
}

/**
 * Get singleton conversation router
 */
let routerInstance: ConversationRouter | null = null;

export function getConversationRouter(): ConversationRouter {
  if (!routerInstance) {
    routerInstance = new ConversationRouter();
  }
  return routerInstance;
}
