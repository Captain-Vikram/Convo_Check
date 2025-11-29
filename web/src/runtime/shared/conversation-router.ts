import { ConversationalMill, type MillConversation } from "../mill/conversational-mill";
import { ConversationalCoach, type CoachConversation } from "../chatur/conversational-coach";
import { SeraAgent, type SeraConversation } from "../sera/sera-agent";
import type { LogCashTransactionPayload } from "@/tools/log-cash-transaction";
import type { SpendingSummaryResult } from "@/tools/query-spending-summary";
import type { AgentInput } from "./multimodal";
import { normalizeAgentInput, summarizeInputForHistory } from "./multimodal";

// Stub type for Param (TODO: implement when schema fixed)
type HabitInsight = any;

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
  // timestamp of last agent switch to prevent rapid oscillation
  lastAgentSwitchAt?: string;
}

export interface ConversationRouterOptions {
  onTransactionReady?: (payload: LogCashTransactionPayload) => Promise<void>;
  onQueryReady?: () => Promise<SpendingSummaryResult>;
  onInsightsAvailable?: () => Promise<HabitInsight[]>;
  onRecentTransactionsReady?: () => Promise<any[]>;
  onPastBriefingsReady?: () => Promise<any[]>;
  onCoachBriefingReady?: (briefing: any) => Promise<void>;
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

/**
 * Extract simple numeric facts and goals from a free-text message.
 * Returns a small object suitable for `session.collectedInfo` merging.
 */
function extractKeyNumbersFromText(text: string): Record<string, unknown> {
  try {
    const out: Record<string, unknown> = {};
    const normalized = (text || "").replace(/[\u20B9,]/g, "").toLowerCase();

    const incomeMatch = normalized.match(/income[^0-9]*(\d+[kKmM]?)/i) || normalized.match(/earn[^0-9]*(\d+[kKmM]?)/i) || normalized.match(/salary[^0-9]*(\d+[kKmM]?)/i);
    if (incomeMatch && incomeMatch[1]) {
      out.income = parseCompactNumber(incomeMatch[1]);
    }

    const savingsMatch = normalized.match(/savings?[^0-9]*(\d+[kKmM]?)/i) || normalized.match(/have\s*(\d+[kKmM]?)\s*savings?/i);
    if (savingsMatch && savingsMatch[1]) {
      out.savings = parseCompactNumber(savingsMatch[1]);
    }

    const amountMatch = normalized.match(/₹?\s*(\d+[kKmM]?)\s*(?:for|to|on)?\s*(phone|house|fund|emergency|sip|emi|loan)?/i);
    if (amountMatch && amountMatch[1]) {
      out.amount = parseCompactNumber(amountMatch[1]);
    }

    const goalMatch = normalized.match(/(?:save|buy|invest)\s+(.*)/i);
    if (goalMatch && goalMatch[1]) {
      out.goal = goalMatch[1].trim();
    }

    return out;
  } catch (e) {
    return {};
  }
}

function parseCompactNumber(raw: string): number {
  try {
    const s = String(raw).trim().toLowerCase();
    if (s.endsWith('k')) return Number(s.slice(0, -1)) * 1000;
    if (s.endsWith('m')) return Number(s.slice(0, -1)) * 1000000;
    return Number(s.replace(/[^0-9.]/g, '')) || 0;
  } catch {
    return 0;
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
    "balance",
    "status",
    "check",
    "account",
    "wallet",
    "expense",
    "spending",
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
    "calculate",
    "invest",
    "sip",
    "emi",
    "split",
    "mutual fund",
    "stock",
    "return",
    "growth",
    "future value",
    "projection",
    "retirement",
    "wealth",
    "allocation",
    "portfolio",
    "loan",
    "interest",
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
    "discount",
    "offer",
    "sale",
    "review",
    "specs",
    "features",
    "emi", // Context dependent
  ] as const;

  constructor(store: ConversationStore = new InMemoryConversationStore()) {
    this.store = store;
    this.mill = new ConversationalMill();
    this.chatur = new ConversationalCoach();
    this.sera = new SeraAgent();
  }

  // Minimum time between agent switches to avoid flip-flopping on rapid messages
  private static readonly SWITCH_COOLDOWN_MS = 2000;

  private canSwitchAgent(context?: ConversationContext): boolean {
    try {
      if (!context || !context.lastAgentSwitchAt) return true;
      const then = Date.parse(context.lastAgentSwitchAt);
      if (isNaN(then)) return true;
      return Date.now() - then >= ConversationRouter.SWITCH_COOLDOWN_MS;
    } catch {
      return true;
    }
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
  ): Promise<{ agent: ActiveAgent; message: string }> {
    const normalizedInput = normalizeAgentInput(firstInput);
    const firstMessage = normalizedInput.text;
    let agent = this.routeInitialMessage(firstMessage);
    if (Array.isArray(normalizedInput.attachments) && normalizedInput.attachments.length > 0) {
      const hasMedia = normalizedInput.attachments.some((a) => a.type === "image" || a.type === "audio");
      if (hasMedia) {
        agent = "mill";
      }
    }

    const context: ConversationContext = {
      activeAgent: agent,
      conversationHistory: [],
      updatedAt: new Date().toISOString(),
    };

    if (agent === "mill") {
      // Start session without initial message
      const millSession = this.mill.startConversation({});
      context.millSessionId = millSession.sessionId;

      // Immediately process the user's first message
      const result = await this.mill.continueConversation(
        millSession.sessionId,
        normalizedInput,
        {
          onTransactionReady: options.onTransactionReady,
          onQueryReady: options.onQueryReady,
        }
      );

      context.conversationHistory.push({
        agent: "mill",
        userMessage: summarizeInputForHistory(normalizedInput),
        agentResponse: result.message,
        timestamp: new Date().toISOString(),
      });
      context.lastAgentSwitchAt = new Date().toISOString();
      await this.persistContext(userId, context);

      return {
        agent: "mill",
        message: result.message,
      };
    } else if (agent === "chatur") {
      const insights = options.onInsightsAvailable ? await options.onInsightsAvailable() : [];
      const financialSummary = options.onQueryReady ? await options.onQueryReady() : undefined;
      const recentTransactions = options.onRecentTransactionsReady ? await options.onRecentTransactionsReady() : undefined;
      const pastBriefings = options.onPastBriefingsReady ? await options.onPastBriefingsReady() : undefined;

      // Start session without initial message
      const chaturSession = this.chatur.startConversation({
        insights,
        financialSummary,
        recentTransactions,
        pastBriefings,
      });
      context.chaturSessionId = chaturSession.sessionId;

      // Extract simple numeric facts from the user's first message to avoid re-probing
      const extracted = extractKeyNumbersFromText(normalizedInput.text || "");
      const result = await this.chatur.continueConversation(
        chaturSession.sessionId,
        normalizedInput,
        { collectedInfo: extracted }
      );

      context.conversationHistory.push({
        agent: "chatur",
        userMessage: summarizeInputForHistory(normalizedInput),
        agentResponse: result.message,
        timestamp: new Date().toISOString(),
      });

      // Persist coach briefings when the LLM returned explicit guidance
      // or when the response appears to be substantive advice produced
      // using rich context (insights / financial summary / recent txns).
      try {
        if (options.onCoachBriefingReady) {
          // 1) Preferred: formal guidance object returned by the agent
          if (result.completed && result.guidance) {
            await options.onCoachBriefingReady(result.guidance);
          } else {
            // 2) Heuristic: if session had rich context and the message
            // looks like actionable advice, synthesize a briefing and save it.
            const chaturSess = chaturSession;
            const hasRichContext = (Array.isArray(chaturSess.insights) && chaturSess.insights.length > 0)
              || (chaturSess.financialSummary && (chaturSess.financialSummary.transactionCount ?? 0) > 0)
              || (Array.isArray(chaturSess.recentTransactions) && chaturSess.recentTransactions.length > 0)
              || (Array.isArray(chaturSess.pastBriefings) && chaturSess.pastBriefings.length > 0);

            const messageIsAdviceLike = typeof result.message === "string" && result.message.trim().length > 120;

            if (hasRichContext && messageIsAdviceLike) {
              const guidance = {
                headline:
                  ((result as any).extractedInfo && ((result as any).extractedInfo as any).headline) ||
                  (result.guidance && result.guidance.headline) ||
                  String(result.message).slice(0, 80),
                counsel: result.message || (((result as any).extractedInfo && ((result as any).extractedInfo as any).counsel) || ""),
                evidence:
                  (chaturSess.insights && chaturSess.insights[0] && chaturSess.insights[0].evidence) ||
                  (((result as any).extractedInfo && ((result as any).extractedInfo as any).evidence) || ""),
              };

              try {
                await options.onCoachBriefingReady(guidance as any);
              } catch (e) {
                // non-fatal: log and continue
                console.error("Failed to persist synthesized coach briefing", e);
              }
            }
          }
        }
      } catch (err) {
        console.error("Error while attempting to persist coach briefing", err);
      }

      await this.persistContext(userId, context);

      return {
        agent: "chatur",
        message: result.message,
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
      };
    }

    // Default: ask what they want to do
    await this.persistContext(userId, context);

    // User requested to remove default message for now
    /*
    return {
      agent: "none",
      message:
        "Hey! 👋 I can help you:\n• Log transactions (Mill)\n• Get financial advice (Chatur)\n• Shop for products (Sera)\n\nWhat would you like to do?",
      sessionId: "welcome",
    };
    */
    return {
      agent: "none",
      message: "", // Empty message as requested
    };
  }

  /**
   * Continue conversation with the appropriate agent
   */
  async continueConversation(
    userId: string,
    userMessage: string | AgentInput,
    options: ConversationRouterOptions = {},
    providedContext?: ConversationContext | string[],
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
    // If caller provided a context, prefer it (stateless operation). Otherwise restore from store.
    let context: ConversationContext | undefined;
    if (Array.isArray(providedContext)) {
      // Convert string[] to minimal ConversationContext
      context = {
        activeAgent: 'none',
        conversationHistory: providedContext.map((m) => ({ agent: 'none' as ActiveAgent, userMessage: m, agentResponse: '', timestamp: new Date().toISOString() })),
        updatedAt: new Date().toISOString(),
      } as ConversationContext;
    } else {
      context = providedContext ? cloneContext(providedContext as ConversationContext) : await this.restoreContext(userId);
    }
  // Stateless mode when caller provided an array of previous messages.
  const isStateless = Array.isArray(providedContext);
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
  if (!isStateless) await this.persistContext(userId, context);
        return handoffResult;
      }

      const result = await this.mill.continueConversation(
        context.millSessionId,
        normalizedInput,
        options,
      );

      // Check if Mill wants to escalate to Chatur
      if (result.action === "escalate_to_coach") {
        if (!this.canSwitchAgent(context)) {
          // Throttle switching to avoid rapid flip-flop
          await this.persistContext(userId, context);
          return {
            agent: "mill",
            message: "I'm still finishing the previous task — give me a moment and then I'll connect you with Chatur.",
            completed: false,
          };
        }
        const insights = options.onInsightsAvailable ? await options.onInsightsAvailable() : [];
        const financialSummary = options.onQueryReady ? await options.onQueryReady() : undefined;
        const recentTransactions = options.onRecentTransactionsReady ? await options.onRecentTransactionsReady() : undefined;
        const pastBriefings = options.onPastBriefingsReady ? await options.onPastBriefingsReady() : undefined;

        const chaturSession = this.chatur.startConversation({
          insights,
          financialSummary,
          recentTransactions,
          pastBriefings,
          initialQuestion: "Perfect! I'm Chatur, your financial coach. Let's work on your financial goals. 🎯",
        });
        context.activeAgent = "chatur";
        context.chaturSessionId = chaturSession.sessionId;
        context.lastAgentSwitchAt = new Date().toISOString();
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

      if (result.completed) {
        delete context.millSessionId;
        context.activeAgent = "none";
      }

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

      // Fetch fresh data for context update
      const insights = options.onInsightsAvailable ? await options.onInsightsAvailable() : undefined;
      const financialSummary = options.onQueryReady ? await options.onQueryReady() : undefined;
      const recentTransactions = options.onRecentTransactionsReady ? await options.onRecentTransactionsReady() : undefined;
      const pastBriefings = options.onPastBriefingsReady ? await options.onPastBriefingsReady() : undefined;

      // Extract numbers/goal from the user's message and merge into collectedInfo
      const extracted = extractKeyNumbersFromText(normalizedInput.text || "");
      const result = await this.chatur.continueConversation(
        context.chaturSessionId,
        normalizedInput,
        {
          insights,
          financialSummary,
          recentTransactions,
          pastBriefings,
          collectedInfo: extracted,
        }
      );

      // Check if Chatur wants to escalate to Mill
      if (result.shouldEscalateToMill) {
        if (!this.canSwitchAgent(context)) {
          await this.persistContext(userId, context);
          return {
            agent: "chatur",
            message: "I'm still processing the previous step — please hold on and I'll switch to Mill shortly.",
            completed: false,
          };
        }
        const millSession = this.mill.startConversation({
          initialMessage: "Sure thing! Let me help you log that. What's the amount and description?",
        });
        context.activeAgent = "mill";
        context.millSessionId = millSession.sessionId;
        context.lastAgentSwitchAt = new Date().toISOString();
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

      if (result.completed) {
        // Save briefing if available
        if (result.guidance && options.onCoachBriefingReady) {
          await options.onCoachBriefingReady(result.guidance);
        }

        delete context.chaturSessionId;
        context.activeAgent = "none";
      }

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
      // Check if user wants to switch to Mill (Transaction/Finance)
      if (this.looksLikeTransactionIntent(textMessage)) {
        this.sera.endConversation(context.seraSessionId, "completed");
        delete context.seraSessionId;
        
        const millSession = this.mill.startConversation({
          initialMessage: "I can help with that transaction. What are the details?",
        });
        if (!this.canSwitchAgent(context)) {
          await this.persistContext(userId, context);
          return {
            agent: "sera",
            message: "I'm still finishing the previous task — please wait a moment.",
            completed: false,
          };
        }

        context.activeAgent = "mill";
        context.lastAgentSwitchAt = new Date().toISOString();
        context.millSessionId = millSession.sessionId;

        // Process the message with Mill immediately
        const result = await this.mill.continueConversation(
          millSession.sessionId,
          normalizedInput,
          options
        );

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
          completed: false,
          switched: true,
          newAgent: "mill",
        };
      }

      // Check if user wants to switch to Chatur (Coaching/Advice)
      if (this.looksLikeCoachingIntent(textMessage)) {
        this.sera.endConversation(context.seraSessionId, "completed");
        delete context.seraSessionId;

        const insights = options.onInsightsAvailable ? await options.onInsightsAvailable() : [];
        const financialSummary = options.onQueryReady ? await options.onQueryReady() : undefined;
        const recentTransactions = options.onRecentTransactionsReady ? await options.onRecentTransactionsReady() : undefined;
        const pastBriefings = options.onPastBriefingsReady ? await options.onPastBriefingsReady() : undefined;

        const chaturSession = this.chatur.startConversation({
          insights,
          financialSummary,
          recentTransactions,
          pastBriefings,
          initialQuestion: "I can definitely help with financial advice. What's on your mind?",
        });
        if (!this.canSwitchAgent(context)) {
          await this.persistContext(userId, context);
          return {
            agent: "sera",
            message: "Hold on — I'm processing the current step; I'll switch you to Chatur shortly.",
            completed: false,
          };
        }

        context.activeAgent = "chatur";
        context.lastAgentSwitchAt = new Date().toISOString();
        context.chaturSessionId = chaturSession.sessionId;

        // Process the message with Chatur immediately
        const result = await this.chatur.continueConversation(
          chaturSession.sessionId,
          normalizedInput
        );

        context.conversationHistory.push({
          agent: "chatur",
          userMessage: summarizeInputForHistory(normalizedInput),
          agentResponse: result.message,
          timestamp: new Date().toISOString(),
        });

        if (result.completed && result.guidance && options.onCoachBriefingReady) {
          await options.onCoachBriefingReady(result.guidance);
        }

        await this.persistContext(userId, context);
        return {
          agent: "chatur",
          message: result.message,
          completed: false,
          switched: true,
          newAgent: "chatur",
        };
      }

      const seraMessage = this.prepareSeraTextInput(normalizedInput);
      const result = await this.sera.continueConversation(context.seraSessionId, seraMessage);

      context.conversationHistory.push({
        agent: "sera",
        userMessage: summarizeInputForHistory(normalizedInput),
        agentResponse: result.message,
        timestamp: new Date().toISOString(),
      });

      if (result.completed) {
        delete context.seraSessionId;
        context.activeAgent = "none";
      }

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

    // Detect product + price questions (e.g. "Is a ₹15,000 phone worth it?", "Is a 15000 rupee laptop worth buying?")
    // Treat these as financial/advice queries and prefer Chatur unless there's an explicit store/platform mention.
    const hasPriceCue = /\u20B9|rs\.?\s?\d+|\d+\s?rs\b|\d{3,}|\d+/.test(lower);
    const hasProductKeyword = /\b(phone|laptop|tv|television|headphone|headphones|watch|fridge|refrigerator|camera|tablet|microwave|ac|air conditioner|fan|shoes|clothing|bike|motorbike|car)\b/.test(lower);
    const hasStoreMention = /amazon|flipkart|croma|myntra|ajio|tatacliq|reliance digital|nykaa|decathlon/.test(lower);
    if (hasPriceCue && hasProductKeyword && !hasStoreMention) {
      return "chatur";
    }

    // 1. Check for Financial Calculation/Planning Intent (Chatur) - Prioritize over shopping
    // "Calculate SIP", "Budget split", "Loan EMI" (without product context)
    if (lower.includes("calculate") || lower.includes("split")) {
      if (lower.includes("sip") || lower.includes("budget") || lower.includes("loan") || lower.includes("invest") || lower.includes("emi")) {
        return "chatur";
      }
    }

    // 2. Check for Investment/Stock/Advice Intent (Chatur)
    if (this.looksLikeCoachingIntent(lower)) {
      return "chatur";
    }

    // 3. Check for Shopping Intent (Sera)
    // Only route to Sera automatically when there's a clear shopping signal: an explicit store/platform mention,
    // or a shopping verb together with a product keyword. This reduces false positives for finance/coach queries.
    if (this.isShoppingIntent(message)) {
      return "sera";
    }

    const millScore = ConversationRouter.keywordScore(ConversationRouter.MILL_KEYWORDS, lower);
    const chaturScore = ConversationRouter.keywordScore(ConversationRouter.CHATUR_KEYWORDS, lower);
    const hasAmount = /\d+/.test(message);

    // 4. Transaction Logging (Mill) - High confidence if amount + transaction keyword
    if (hasAmount && this.looksLikeTransactionIntent(lower)) {
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

  private looksLikeCoachingIntent(lower: string): boolean {
    // Added "should i buy" to catch purchase advice questions
    if (lower.includes("should i buy") || lower.includes("can i afford")) {
      return true;
    }
    return /\b(advice|tip|help|goal|save|budget|plan|reduce|improve|habit|coach|guidance|strategy|invest|sip|mutual fund|stock|portfolio|wealth|retirement|loan|interest|emi)\b/.test(lower);
  }

  private looksLikeTransactionIntent(lower: string): boolean {
    return /\b(spent|spend|pay|paid|log|record|salary|income|earned|received|deposit|withdraw|transfer|credited|debited|balance|status|check)\b/.test(
      lower,
    );
  }

  private isShoppingIntent(message: string): boolean {
    const lower = message.toLowerCase();
    
    // Exclude financial investment queries from shopping
    const hasFinancialContext = /stock|share|market|invest|fund|sip|mutual|equity|crypto|bitcoin|gold|silver|bond|fd|rd|portfolio|nav|sensex|nifty|loan|emi|afford/.test(lower);
    if (hasFinancialContext) {
      return false;
    }

    // Exclude advice questions ("Should I buy...")
    if (lower.includes("should i buy") || lower.includes("can i afford")) {
      return false;
    }
    const keywordScore = ConversationRouter.keywordScore(ConversationRouter.SERA_KEYWORDS, lower);
    const transactionCue = this.looksLikeTransactionIntent(lower);

    // Strong store mention / platform -> shopping
    const hasStore = /amazon|flipkart|croma|myntra|ajio|tatacliq|reliance digital|nykaa|decathlon/.test(lower);

    // Product nouns
    const hasProductKeyword = /\b(phone|laptop|tv|television|headphone|headphones|watch|shoes|clothing|camera|tablet|fridge|refrigerator|microwave|ac|air conditioner|fan)\b/.test(lower);

    // Purchase-related verbs/phrases (stronger signals than the generic word "shopping")
    const hasBuyVerb = /\b(buy|purchase|order|where to buy|where can i buy|best deal|cheapest|price|compare)\b/.test(lower);

    // Generic "shopping" word should not by itself trigger Sera unless accompanied by a product/store/buy-verb
    const containsShoppingWord = /\bshopping\b/.test(lower);
    if (containsShoppingWord && !hasStore && !hasProductKeyword && !hasBuyVerb) {
      return false;
    }

    // If user is clearly asking about a transaction/finance item, don't treat it as shopping (unless there's a clear buy intent + product)
    if (transactionCue && !hasBuyVerb && !hasProductKeyword && !hasStore) {
      return false;
    }

    // Explicit store mention is a clear shopping intent
    if (hasStore) return true;

    // Require buy-verb or the word "shopping" together with a product noun
    if ((hasBuyVerb || containsShoppingWord) && hasProductKeyword) return true;

    // Conservative fallback: require SERA keywords + product noun and no transaction cue
    return keywordScore > 0 && !transactionCue && hasProductKeyword;
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
