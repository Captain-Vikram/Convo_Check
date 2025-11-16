import { ConversationalMill, type MillConversation } from "../mill/conversational-mill.js";
import { ConversationalCoach, type CoachConversation } from "../chatur/conversational-coach.js";
import { SeraAgent, type SeraConversation } from "../sera/sera-agent.js";
import type { HabitInsight } from "../param/analyst-agent.js";
import type { LogCashTransactionPayload } from "../../tools/log-cash-transaction.js";
import type { SpendingSummaryResult } from "../../tools/query-spending-summary.js";
import type { AgentInput } from "./multimodal.js";
import { normalizeAgentInput, summarizeInputForHistory } from "./multimodal.js";

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
  millSession?: MillConversation;
  chaturSession?: CoachConversation;
  seraSession?: SeraConversation;
  conversationHistory: Array<{
    agent: ActiveAgent;
    userMessage: string;
    agentResponse: string;
    timestamp: string;
  }>;
  updatedAt: string;
}

export interface ConversationRouterOptions {
  onTransactionReady?: (payload: LogCashTransactionPayload) => Promise<void>;
  onQueryReady?: () => Promise<SpendingSummaryResult>;
  onInsightsAvailable?: () => Promise<HabitInsight[]>;
}

export interface ConversationStore {
  load(userId: string): Promise<ConversationContext | undefined>;
  save(userId: string, context: ConversationContext): Promise<void>;
  delete(userId: string): Promise<void>;
  cleanup?(maxAgeMs: number): Promise<void>;
}

export class InMemoryConversationStore implements ConversationStore {
  private contexts = new Map<string, ConversationContext>();

  async load(userId: string): Promise<ConversationContext | undefined> {
    const context = this.contexts.get(userId);
    return context ? cloneContext(context) : undefined;
  }

  async save(userId: string, context: ConversationContext): Promise<void> {
    this.contexts.set(userId, cloneContext(context));
  }

  async delete(userId: string): Promise<void> {
    this.contexts.delete(userId);
  }

  async cleanup(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    for (const [userId, context] of this.contexts.entries()) {
      if (!context.updatedAt || Date.parse(context.updatedAt) < cutoff) {
        this.contexts.delete(userId);
      }
    }
  }
}

export class ConversationRouter {
  private mill: ConversationalMill;
  private chatur: ConversationalCoach;
  private sera: SeraAgent;
  private readonly store: ConversationStore;

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

  constructor(store: ConversationStore = new InMemoryConversationStore()) {
    this.store = store;
    this.mill = new ConversationalMill();
    this.chatur = new ConversationalCoach();
    this.sera = new SeraAgent();
  }

  private async restoreContext(userId: string): Promise<ConversationContext | undefined> {
    const stored = await this.store.load(userId);
    if (!stored) {
      return undefined;
    }

    const context = cloneContext(stored);
    this.hydrateAgentSessions(context);
    return context;
  }

  private hydrateAgentSessions(context: ConversationContext): void {
    if (context.millSession && context.millSessionId) {
      this.mill.hydrateSession(context.millSession);
    }

    if (context.chaturSession && context.chaturSessionId) {
      this.chatur.hydrateSession(context.chaturSession);
    }

    if (context.seraSession && context.seraSessionId) {
      this.sera.hydrateSession(context.seraSession);
    }
  }

  private async persistContext(userId: string, context: ConversationContext): Promise<void> {
    const snapshot = cloneContext(context);
    snapshot.updatedAt = new Date().toISOString();

    if (snapshot.millSessionId) {
      const session = this.mill.snapshotSession(snapshot.millSessionId);
      if (session) {
        snapshot.millSession = session;
        this.mill.releaseSession(snapshot.millSessionId);
      } else {
        delete snapshot.millSession;
      }
    } else {
      delete snapshot.millSession;
    }

    if (snapshot.chaturSessionId) {
      const session = this.chatur.snapshotSession(snapshot.chaturSessionId);
      if (session) {
        snapshot.chaturSession = session;
        this.chatur.releaseSession(snapshot.chaturSessionId);
      } else {
        delete snapshot.chaturSession;
      }
    } else {
      delete snapshot.chaturSession;
    }

    if (snapshot.seraSessionId) {
      const session = this.sera.snapshotSession(snapshot.seraSessionId);
      if (session) {
        snapshot.seraSession = session;
        this.sera.releaseSession(snapshot.seraSessionId);
      } else {
        delete snapshot.seraSession;
      }
    } else {
      delete snapshot.seraSession;
    }

    await this.store.save(userId, snapshot);
  }

  /**
   * Start a new conversation - intelligently route based on first message
   */
  async startConversation(
    userId: string,
    firstInput: string | AgentInput,
    options: ConversationRouterOptions = {},
  ): Promise<{ agent: ActiveAgent; message: string; sessionId: string }> {
    const normalizedInput = normalizeAgentInput(firstInput);
    const firstMessage = normalizedInput.text;
    // Determine which agent should handle this
    const agent = this.routeInitialMessage(firstMessage);

    const context: ConversationContext = {
      activeAgent: agent,
      conversationHistory: [],
      updatedAt: new Date().toISOString(),
    };

    if (agent === "mill") {
      const millSession = this.mill.startConversation({
        initialMessage:
          "Hey! 👋 What's up? I can help you log transactions or check your spending. Need shopping help? I can loop in Sera—our deal-hunting shopping buddy. 🛍️",
      });
      context.millSessionId = millSession.sessionId;
      context.conversationHistory.push({
        agent: "mill",
        userMessage: summarizeInputForHistory(normalizedInput),
        agentResponse: millSession.messages[0]?.content || "",
        timestamp: new Date().toISOString(),
      });
      await this.persistContext(userId, context);

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
        userMessage: summarizeInputForHistory(normalizedInput),
        agentResponse: chaturSession.currentQuestion || "",
        timestamp: new Date().toISOString(),
      });
      await this.persistContext(userId, context);

      return {
        agent: "chatur",
        message: chaturSession.currentQuestion || "",
        sessionId: chaturSession.sessionId,
      };
    } else if (agent === "sera") {
      const seraSession = this.sera.startConversation({ suppressGreeting: true });
      context.seraSessionId = seraSession.sessionId;
      const seraMessage = this.prepareSeraTextInput(normalizedInput);
      const seraResult = await this.sera.continueConversation(seraSession.sessionId, seraMessage);

      context.conversationHistory.push({
        agent: "sera",
        userMessage: summarizeInputForHistory(normalizedInput),
        agentResponse: seraResult.message,
        timestamp: new Date().toISOString(),
      });
      await this.persistContext(userId, context);

      return {
        agent: "sera",
        message: seraResult.message,
        sessionId: seraSession.sessionId,
      };
    }

    // Default: ask what they want to do
    await this.persistContext(userId, context);

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
    userMessage: string | AgentInput,
    options: ConversationRouterOptions = {},
  ): Promise<{
    agent: ActiveAgent;
    message: string;
    completed: boolean;
    switched?: boolean;
    newAgent?: ActiveAgent;
    result?: unknown;
  }> {
    const normalizedInput = normalizeAgentInput(userMessage);
    const textMessage = normalizedInput.text;
    const context = await this.restoreContext(userId);
    if (!context) {
      const startResult = await this.startConversation(userId, normalizedInput, options);
      return { ...startResult, completed: false };
    }

    const { activeAgent } = context;

    // Route to Mill
    if (activeAgent === "mill" && context.millSessionId) {
      if (this.isShoppingIntent(textMessage)) {
        this.mill.endConversation(context.millSessionId, "completed");
        delete context.millSessionId;
        const handoffResult = await this.handoffToSera(context, normalizedInput);
        await this.persistContext(userId, context);
        return handoffResult;
      }

      const result = await this.mill.continueConversation(
        context.millSessionId,
        normalizedInput,
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

        await this.persistContext(userId, context);
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
        userMessage: summarizeInputForHistory(normalizedInput),
        agentResponse: result.message,
        timestamp: new Date().toISOString(),
      });

      await this.persistContext(userId, context);
      return {
        agent: "mill",
        message: result.message,
        completed: result.completed,
        result: result.payload,
      };
    }

    // Route to Chatur
    if (activeAgent === "chatur" && context.chaturSessionId) {
      if (this.isShoppingIntent(textMessage)) {
        this.chatur.endConversation(context.chaturSessionId, "completed");
        delete context.chaturSessionId;
        const handoffResult = await this.handoffToSera(context, normalizedInput);
        await this.persistContext(userId, context);
        return handoffResult;
      }

      const result = await this.chatur.continueConversation(context.chaturSessionId, normalizedInput);

      // Check if Chatur wants to escalate to Mill
      if (result.shouldEscalateToMill) {
        const millSession = this.mill.startConversation({
          initialMessage: "Sure thing! Let me help you log that. What's the amount and description?",
        });
        context.activeAgent = "mill";
        context.millSessionId = millSession.sessionId;

        await this.persistContext(userId, context);
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
        userMessage: summarizeInputForHistory(normalizedInput),
        agentResponse: result.message,
        timestamp: new Date().toISOString(),
      });

      await this.persistContext(userId, context);
      return {
        agent: "chatur",
        message: result.message,
        completed: result.completed,
        result: result.guidance,
      };
    }

    // Route to Sera
    if (activeAgent === "sera" && context.seraSessionId) {
      const seraMessage = this.prepareSeraTextInput(normalizedInput);
      const result = await this.sera.continueConversation(context.seraSessionId, seraMessage);

      context.conversationHistory.push({
        agent: "sera",
        userMessage: summarizeInputForHistory(normalizedInput),
        agentResponse: result.message,
        timestamp: new Date().toISOString(),
      });

      await this.persistContext(userId, context);
      return {
        agent: "sera",
        message: result.message,
        completed: result.completed,
        result: result.searchResults,
      };
    }

    // No active agent - route based on message
    const startResult = await this.startConversation(userId, normalizedInput, options);
    return { ...startResult, completed: false };
  }

  /**
   * Get current conversation context
   */
  async getContext(userId: string): Promise<ConversationContext | undefined> {
    const stored = await this.store.load(userId);
    return stored ? cloneContext(stored) : undefined;
  }

  /**
   * End conversation and cleanup
   */
  async endConversation(userId: string): Promise<void> {
    const context = await this.restoreContext(userId);
    if (context) {
      if (context.millSessionId) {
        this.mill.endConversation(context.millSessionId, "completed");
        this.mill.releaseSession(context.millSessionId);
      }
      if (context.chaturSessionId) {
        this.chatur.endConversation(context.chaturSessionId, "completed");
        this.chatur.releaseSession(context.chaturSessionId);
      }
      if (context.seraSessionId) {
        this.sera.endConversation(context.seraSessionId, "completed");
        this.sera.releaseSession(context.seraSessionId);
      }
    }

    await this.store.delete(userId);
  }

  /**
   * Cleanup old conversations
   */
  async cleanup(maxAgeMs = 3600_000): Promise<void> {
    if (typeof this.store.cleanup === "function") {
      await this.store.cleanup(maxAgeMs);
    }

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
    userInput: AgentInput,
    announcement?: string,
  ): Promise<{
    agent: ActiveAgent;
    message: string;
    completed: boolean;
    switched: true;
    newAgent: ActiveAgent;
    result?: unknown;
  }> {
    let announcementMessage: string | undefined = announcement;

    if (!context.seraSessionId) {
      const seraSession = this.sera.startConversation({ suppressGreeting: true });
      context.seraSessionId = seraSession.sessionId;
    }

    context.activeAgent = "sera";

    const sessionId = context.seraSessionId!;
    const seraMessage = this.prepareSeraTextInput(userInput);
    const result = await this.sera.continueConversation(sessionId, seraMessage);

    const combinedMessage = [announcementMessage, result.message]
      .filter((part): part is string => Boolean(part && part.trim().length > 0))
      .join("\n\n");

    context.conversationHistory.push({
      agent: "sera",
      userMessage: summarizeInputForHistory(userInput),
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

  private prepareSeraTextInput(input: AgentInput): string {
    const trimmed = input.text?.trim();
    if (trimmed && trimmed.length > 0) {
      return trimmed;
    }

    return summarizeInputForHistory(input);
  }

  /**
   * Get conversation summary for the user
   */
  async getConversationSummary(userId: string): Promise<string> {
    const context = await this.store.load(userId);
    if (!context || context.conversationHistory.length === 0) {
      return "No conversation history.";
    }

    const lines: string[] = [];
    lines.push(`Active Agent: ${context.activeAgent}`);
    lines.push(`\nConversation History (${context.conversationHistory.length} turns):\n`);

    context.conversationHistory
      .slice(-5)
      .forEach((turn: ConversationContext["conversationHistory"][number], idx: number) => {
        lines.push(`${idx + 1}. [${turn.agent.toUpperCase()}]`);
        lines.push(`   You: ${turn.userMessage.slice(0, 60)}...`);
        const agentName = turn.agent === "mill" ? "Mill" : turn.agent === "chatur" ? "Chatur" : "Sera";
        lines.push(`   ${agentName}: ${turn.agentResponse.slice(0, 60)}...`);
      });

    return lines.join("\n");
  }
}

function cloneContext(context: ConversationContext): ConversationContext {
  if (typeof structuredClone === "function") {
    return structuredClone(context);
  }

  return JSON.parse(JSON.stringify(context)) as ConversationContext;
}
