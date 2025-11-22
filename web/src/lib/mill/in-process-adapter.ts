import {
  ConversationRouter,
  type ConversationRouterOptions,
  type ConversationContext,
  type ActiveAgent,
} from "@/runtime/shared/conversation-router";
import type { AgentAttachment, AgentInput } from "@/runtime/shared/multimodal";
import { getConversationStore } from "./conversation-store";
import { prisma } from "@/lib/prisma";
import type { SpendingSummaryResult } from "@/tools/query-spending-summary";
import type { HabitInsight } from "@/runtime/param/analyst-agent";
import { runAnalyst } from "@/runtime/param/analyst-agent";
import type { LogCashTransactionPayload } from "@/tools/log-cash-transaction";
import { randomUUID } from "node:crypto";

const conversationRouter = new ConversationRouter(getConversationStore());

export interface AgentEntryRequest {
  userId: string;
  message?: string;
  attachments?: AgentAttachment[];
  options?: ConversationRouterOptions;
}

export interface AgentEntryResponse {
  agent: ActiveAgent;
  message: string;
  completed: boolean;
  switched?: boolean;
  newAgent?: ActiveAgent;
  result?: unknown;
  sessionId?: string;
  context?: ConversationContext;
}

function resolveSessionId(context?: ConversationContext, agent?: ActiveAgent): string | undefined {
  if (!context) return undefined;
  switch (agent ?? context.activeAgent) {
    case "mill":
      return context.millSessionId;
    case "chatur":
      return context.chaturSessionId;
    case "sera":
      return context.seraSessionId;
    default:
      return context.millSessionId ?? context.chaturSessionId ?? context.seraSessionId;
  }
}

async function fetchUserInsights(userId: string): Promise<HabitInsight[]> {
  try {
    const ownerId = parseInt(userId, 10);
    if (isNaN(ownerId)) return [];

    // Trigger analyst run for fresh data
    try {
      await runAnalyst({ ownerId, trigger: "chatur" });
    } catch (e) {
      console.error("Failed to run analyst", e);
    }

    const insights = await prisma.habit_insights.findMany({
      where: { owner: ownerId, superseded: false },
      orderBy: { recorded_at: "desc" },
      take: 5,
    });

    return insights.map((i) => ({
      habitLabel: i.habit_label ?? "",
      evidence: i.evidence ?? "",
      counsel: i.counsel ?? "",
      fullText: i.full_text ?? "",
    }));
  } catch (e) {
    console.error("Failed to fetch insights", e);
    return [];
  }
}

async function fetchRecentTransactions(userId: string): Promise<any[]> {
  try {
    const ownerId = parseInt(userId, 10);
    if (isNaN(ownerId)) return [];
    return await prisma.tranasctions.findMany({
      where: { owner: ownerId, status: "Active" },
      orderBy: { date_of_transaction: "desc" },
      take: 20,
    });
  } catch (e) {
    console.error("Failed to fetch recent transactions", e);
    return [];
  }
}

async function fetchPastBriefings(userId: string): Promise<any[]> {
  try {
    const ownerId = parseInt(userId, 10);
    if (isNaN(ownerId)) return [];
    return await prisma.coach_briefings.findMany({
      where: { owner: ownerId },
      orderBy: { date_created: "desc" },
      take: 5,
    });
  } catch (e) {
    console.error("Failed to fetch past briefings", e);
    return [];
  }
}

async function saveCoachBriefing(userId: string, briefing: CoachBriefing): Promise<void> {
  try {
    const ownerId = parseInt(userId, 10);
    if (isNaN(ownerId)) return;
    
    await prisma.coach_briefings.create({
      data: {
        id: randomUUID(),
        owner: ownerId,
        headline: briefing.headline || "Coach Advice",
        counsel: briefing.counsel || briefing.message || "",
        evidence: briefing.evidence || "",
        status: "Active",
        date_created: new Date(),
        insight_hash: randomUUID(),
      }
    });
  } catch (e) {
    console.error("Failed to save coach briefing", e);
  }
}

async function fetchFinancialSummary(userId: string): Promise<SpendingSummaryResult> {
  try {
    const ownerId = parseInt(userId, 10);
    if (isNaN(ownerId)) throw new Error("Invalid user ID");

    const transactions = await prisma.tranasctions.findMany({
      where: { owner: ownerId, status: "Active" },
      orderBy: { date_of_transaction: "desc" },
    });

    let totalIncome = 0;
    let totalExpense = 0;
    const categoryMap = new Map<string, number>();

    for (const t of transactions) {
      const amount = Number(t.amount);
      // Handle both legacy (income/expense) and new (credit/debit) types
      const isIncome = t.type === "income" || t.type === "credit";
      const isExpense = t.type === "expense" || t.type === "debit";

      if (isIncome) {
        totalIncome += amount;
      } else if (isExpense) {
        totalExpense += amount;
        const cat = t.category || "Uncategorized";
        categoryMap.set(cat, (categoryMap.get(cat) || 0) + amount);
      }
    }

    const topCategories = Array.from(categoryMap.entries())
      .map(([category, totalSpent]) => ({ category, totalSpent, count: 0 }))
      .sort((a, b) => b.totalSpent - a.totalSpent)
      .slice(0, 5);

    return {
      totalIncome,
      totalExpense,
      netBalance: totalIncome - totalExpense,
      transactionCount: transactions.length,
      recentTransactions: [],
      topCategories,
      paramInsights: [],
      coachAdvice: null,
    };
  } catch (e) {
    console.error("Failed to fetch financial summary", e);
    return {
      totalIncome: 0,
      totalExpense: 0,
      netBalance: 0,
      transactionCount: 0,
      recentTransactions: [],
      topCategories: [],
      paramInsights: [],
      coachAdvice: null,
    };
  }
}

async function logTransaction(userId: string, payload: LogCashTransactionPayload): Promise<void> {
  const ownerId = parseInt(userId, 10);
  if (isNaN(ownerId)) throw new Error("Invalid user ID");

  await prisma.tranasctions.create({
    data: {
      id: randomUUID(),
      owner: ownerId,
      amount: payload.amount,
      description: payload.description,
      category: payload.category_suggestion,
      type: payload.type,
      status: "Active",
      date_of_transaction: new Date(),
      date_created: new Date(),
      date_updated: new Date(),
    },
  });
}

export async function processAgentMessage(
  req: AgentEntryRequest,
): Promise<AgentEntryResponse> {
  if (!req?.userId?.trim()) {
    throw new Error("userId is required");
  }
  const hasMessage = Boolean(req?.message?.trim());
  const hasAttachments = Array.isArray(req.attachments) && req.attachments.length > 0;

  if (!hasMessage && !hasAttachments) {
    throw new Error("Either message or attachments are required");
  }

  const agentInput: AgentInput = {
    text: req.message ?? "",
    attachments: hasAttachments ? req.attachments : undefined,
  };

  const response = await conversationRouter.continueConversation(
    req.userId,
    agentInput,
    {
      ...req.options,
      onInsightsAvailable: req.options?.onInsightsAvailable ?? (() => fetchUserInsights(req.userId)),
      onQueryReady: req.options?.onQueryReady ?? (() => fetchFinancialSummary(req.userId)),
      onTransactionReady: req.options?.onTransactionReady ?? ((payload) => logTransaction(req.userId, payload)),
      onRecentTransactionsReady: () => fetchRecentTransactions(req.userId),
      onPastBriefingsReady: () => fetchPastBriefings(req.userId),
      onCoachBriefingReady: (briefing) => saveCoachBriefing(req.userId, briefing),
    },
  );

  const context = await conversationRouter.getContext(req.userId);
  const sessionId =
    (response as { sessionId?: string }).sessionId ?? resolveSessionId(context, response.agent);

  return {
    ...response,
    sessionId,
    context,
  };
}

export default processAgentMessage;
