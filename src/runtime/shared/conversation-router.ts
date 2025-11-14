import { ConversationalMill, type MillConversation } from "../mill/conversational-mill.js";
import { ConversationalCoach, type CoachConversation } from "../chatur/conversational-coach.js";
import { SeraAgent, type SeraConversation } from "../sera/sera-agent.js";
import type { HabitInsight } from "../param/analyst-agent.js";
import type { LogCashTransactionPayload } from "../../tools/log-cash-transaction.js";
import type { SpendingSummaryResult } from "../../tools/query-spending-summary.js";

/**
 * Intelligent conversation router that understands when to use Mill vs Chatur vs Sera
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
 * 
 * SERA specializes in:
 * - Product search and shopping assistance
 * - Price comparison across Indian e-commerce
 * - Wishlist management and price tracking
 * - Shopping recommendations and deals
 */

export type ActiveAgent = "mill" | "chatur" | "sera" | "none";

export interface ConversationContext {
  activeAgent: ActiveAgent;
  millSessionId?: string;
  chaturSessionId?: string;
  seraSessionId?: string;
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
  private sera: SeraAgent;
  private contexts = new Map<string, ConversationContext>();

  private static readonly MILL_KEYWORDS = [
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
  ] as const;

  private static readonly CHATUR_KEYWORDS = [
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
  ] as const;

  private static readonly SERA_KEYWORDS = [
    "search",
    "find",
    "buy",
    "shop",
    "product",
    "price",
    "compare",
    "looking for",
    "want to buy",
    "need to buy",
    "show me products",
    "best deal",
    "cheapest",
    "wishlist",
    "shopping",
    "purchase",
    "where to buy",
    "amazon",
    "flipkart",
    "laptop",
    "phone",
    "headphones",
    "mouse",
    "keyboard",
    "watch",
    "shoes",
    "clothing",
  ] as const;

  constructor() {
    this.mill = new ConversationalMill();
    this.chatur = new ConversationalCoach();
    this.sera = new SeraAgent();
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
        initialMessage:
          "Hey! 👋 What's up? I can help you log transactions or check your spending. Need shopping help? I can loop in Sera—our deal-hunting shopping buddy. 🛍️",
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
    } else if (agent === "sera") {
      const seraSession = this.sera.startConversation({
        initialGreeting:
          "Hey! 🛍️ I'm Sera, your shopping buddy! I can help you find and compare products across Indian stores. What are you looking to buy?",
      });
      context.seraSessionId = seraSession.sessionId;
      context.conversationHistory.push({
        agent: "sera",
        userMessage: firstMessage,
        agentResponse: seraSession.messages[0]?.content || "",
        timestamp: new Date().toISOString(),
      });

      this.contexts.set(userId, context);

      return {
        agent: "sera",
        message: seraSession.messages[0]?.content || "",
        sessionId: seraSession.sessionId,
      };
    }

    // Default: ask what they want to do
    return {
      agent: "none",
      message:
        "Hey! 👋 I can help you:\n• Log transactions (Mill)\n• Get financial advice (Chatur)\n• Shop for products (Sera)\n\nWhat would you like to do?",
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
      if (this.isShoppingIntent(userMessage)) {
        this.mill.endConversation(context.millSessionId, "completed");
        delete context.millSessionId;
        return await this.handoffToSera(
          context,
          userMessage,
          "Mill here! I\'m looping in Sera—our shopping specialist who finds trusted Indian deals, compares prices, and manages wishlists. She\'ll take it from here. 🛍️",
        );
      }

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
      if (this.isShoppingIntent(userMessage)) {
        this.chatur.endConversation(context.chaturSessionId, "completed");
        delete context.chaturSessionId;
        return await this.handoffToSera(
          context,
          userMessage,
          "Bringing Sera in! She\'s our shopping buddy who can hunt for products, compare prices, and build your wishlist. 🛍️",
        );
      }

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

    // Route to Sera
    if (activeAgent === "sera" && context.seraSessionId) {
      const result = await this.sera.continueConversation(context.seraSessionId, userMessage);

      context.conversationHistory.push({
        agent: "sera",
        userMessage,
        agentResponse: result.message,
        timestamp: new Date().toISOString(),
      });

      return {
        agent: "sera",
        message: result.message,
        completed: result.completed,
        result: result.searchResults,
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
      if (context.seraSessionId) {
        this.sera.endConversation(context.seraSessionId, "completed");
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
    this.sera.cleanupOldSessions(maxAgeMs);
  }

  /**
   * Intelligently route initial message to appropriate agent
   */
  private routeInitialMessage(message: string): ActiveAgent {
    const lower = message.toLowerCase();

    if (this.isShoppingIntent(message)) {
      return "sera";
    }

    const millScore = ConversationRouter.keywordScore(ConversationRouter.MILL_KEYWORDS, lower);
    const chaturScore = ConversationRouter.keywordScore(ConversationRouter.CHATUR_KEYWORDS, lower);
    const hasAmount = /\d+/.test(message);

    if (hasAmount && millScore >= chaturScore) {
      return "mill";
    }

    if (millScore > chaturScore) {
      return "mill";
    }

    if (chaturScore > millScore) {
      return "chatur";
    }

    return "none";
  }

  private static keywordScore(keywords: readonly string[], lower: string): number {
    return keywords.reduce((score, keyword) => (lower.includes(keyword) ? score + 1 : score), 0);
  }

  private looksLikeTransactionIntent(lower: string): boolean {
    return /\b(spent|spend|pay|paid|log|record|salary|income|earned|received|deposit|withdraw|transfer|credited|debited)\b/.test(
      lower,
    );
  }

  private isShoppingIntent(message: string): boolean {
    const lower = message.toLowerCase();
    const keywordScore = ConversationRouter.keywordScore(ConversationRouter.SERA_KEYWORDS, lower);
    const hasStoreMention = /amazon|flipkart|croma|myntra|ajio|tatacliq|reliance digital|nykaa|decathlon/.test(
      lower,
    );
    const hasShoppingVerb = /buy|shop|shopping|wishlist|compare|deal|product|price|purchase|order|best|recommend|search/.test(
      lower,
    );
    const transactionCue = this.looksLikeTransactionIntent(lower);

    if (transactionCue && !hasStoreMention && !hasShoppingVerb) {
      return false;
    }

    if (hasStoreMention || hasShoppingVerb) {
      return true;
    }

    return keywordScore > 0 && !transactionCue;
  }

  private async handoffToSera(
    context: ConversationContext,
    userMessage: string,
    announcement?: string,
  ): Promise<{
    agent: ActiveAgent;
    message: string;
    completed: boolean;
    switched: true;
    newAgent: ActiveAgent;
    result?: unknown;
  }> {
    let greeting: string | undefined;

    if (!context.seraSessionId) {
      const seraSession = this.sera.startConversation({
        initialGreeting:
          announcement ??
          "Hey! 🛍️ I'm Sera, your shopping buddy. I compare Indian stores, surface the best deals, and can save items to your wishlist.",
      });
      context.seraSessionId = seraSession.sessionId;
      greeting = seraSession.messages[0]?.content;
    } else if (announcement) {
      greeting = announcement;
    }

    context.activeAgent = "sera";

    const sessionId = context.seraSessionId!;
    const result = await this.sera.continueConversation(sessionId, userMessage);

    const combinedMessage = [greeting, result.message]
      .filter((part): part is string => Boolean(part && part.trim().length > 0))
      .join("\n\n");

    context.conversationHistory.push({
      agent: "sera",
      userMessage,
      agentResponse: combinedMessage || result.message,
      timestamp: new Date().toISOString(),
    });

    return {
      agent: "sera",
      message: combinedMessage || result.message,
      completed: result.completed,
      switched: true,
      newAgent: "sera",
      result: result.searchResults,
    };
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
      const agentName = turn.agent === "mill" ? "Mill" : turn.agent === "chatur" ? "Chatur" : "Sera";
      lines.push(`   ${agentName}: ${turn.agentResponse.slice(0, 60)}...`);
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
