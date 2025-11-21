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

    const insights = await prisma.habit_insights.findMany({
      where: { owner: ownerId, status: "published" },
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

async function fetchFinancialSummary(userId: string): Promise<SpendingSummaryResult> {
  try {
    const ownerId = parseInt(userId, 10);
    if (isNaN(ownerId)) throw new Error("Invalid user ID");

    const transactions = await prisma.tranasctions.findMany({
      where: { owner: ownerId, status: "published" },
      orderBy: { date_of_transaction: "desc" },
    });

    let totalIncome = 0;
    let totalExpense = 0;
    const categoryMap = new Map<string, number>();

    for (const t of transactions) {
      const amount = Number(t.amount);
      if (t.type === "income") {
        totalIncome += amount;
      } else if (t.type === "expense") {
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
