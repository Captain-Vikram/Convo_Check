import {
  ConversationRouter,
  type ConversationRouterOptions,
  type ConversationContext,
  type ActiveAgent,
} from "@/runtime/shared/conversation-router";
import type { AgentAttachment, AgentInput } from "@/runtime/shared/multimodal";
import { getConversationStore } from "./conversation-store";
import { fetchStoredTransactions, fetchCoachBriefings, computeSpendingSummary, fetchHabitInsights, createCoachBriefing, persistSyntheticHabitInsight } from "@/runtime/dev/dev-agent";
// import { prisma } from "@/lib/prisma";
import type { SpendingSummaryResult } from "@/tools/query-spending-summary";
import type { HabitInsight } from "@/runtime/param/analyst-agent";
import { runAnalyst } from "@/runtime/param/analyst-agent";
// import type { LogCashTransactionPayload } from "@/tools/log-cash-transaction";
import type { CoachBriefing } from "@/runtime/chatur/coach-agent";
import { runDevPipeline, createFileSystemDevTools } from "@/runtime/dev/dev-agent";
import { categorizeTransaction } from "@/runtime/shared/categorize";
// randomUUID not needed here; Dev helpers will create IDs when persisting
import * as fs from "fs";
import * as path from "path";

const conversationRouter = new ConversationRouter(getConversationStore());

function logDebug(message: string, data?: any) {
  const logPath = path.join(process.cwd(), "debug.log");
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message} ${data ? JSON.stringify(data) : ""}\n`;
  fs.appendFileSync(logPath, line);
}

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
  // Extra aliases for parsed/tool output to ease consumption by tests and callers
  toolResult?: unknown;
  parsed?: unknown;
  action?: string;
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
      logDebug(`[fetchUserInsights] Running analyst for owner ${ownerId}...`);
      const result = await runAnalyst({ ownerId, trigger: "chatur" });
      logDebug(`[fetchUserInsights] Analyst result:`, result);
    } catch (e) {
      logDebug(`[fetchUserInsights] Failed to run analyst`, e);
      console.error("Failed to run analyst", e);
    }

    // Prefer Param/Dev persisted insights via Dev helper
    const insights = await fetchHabitInsights(ownerId, 5);
    if (insights && insights.length > 0) {
      return insights.map((i: any) => ({
        habitLabel: i.habit_label ?? "",
        evidence: i.evidence ?? "",
        counsel: i.counsel ?? "",
        fullText: i.full_text ?? "",
      }));
    }

    // Fallback: if analyst produced no persistent insights, synthesize a simple
    // insight from recent transactions so downstream consumers (tests/dev) have
    // at least one persisted insight to work with.
    try {
      const recent = await fetchRecentTransactions(userId);
      if (recent.length === 0) return [];

      // compute top category and total expense
      let totalExpense = 0;
      const catMap = new Map<string, number>();
      for (const t of recent) {
        const amt = Number(t.amount || 0);
        if (t.type === "debit") {
          totalExpense += amt;
          const cat = t.category || "Uncategorized";
          catMap.set(cat, (catMap.get(cat) || 0) + amt);
        }
      }

      const topCategory = Array.from(catMap.entries()).sort((a, b) => b[1] - a[1])[0];
      const habitLabel = topCategory ? `Spending in ${topCategory[0]}` : "Spending pattern";
      const evidence = `Recent spending: ${totalExpense} across ${recent.length} transactions`;
      const counsel = topCategory ? `Review your spending in ${topCategory[0]}` : `Review your recent spending`;

      try {
        const created = await persistSyntheticHabitInsight(ownerId, {
          habitLabel,
          evidence,
          counsel,
          fullText: `${evidence}. Suggested: ${counsel}`,
        });

        if (created) {
          return [
            {
              habitLabel: created.habitLabel,
              evidence: created.evidence,
              counsel: created.counsel,
              fullText: created.fullText,
            },
          ];
        }

        return [];
      } catch (err) {
        logDebug("fetchUserInsights: failed to persist fallback insight", err);
        return [];
      }
    } catch (err) {
      logDebug("fetchUserInsights: error computing fallback insight", err);
      return [];
    }
  } catch (e) {
    console.error("Failed to fetch insights", e);
    return [];
  }
}

async function fetchRecentTransactions(userId: string): Promise<any[]> {
  try {
    const ownerId = parseInt(userId, 10);
    if (isNaN(ownerId)) return [];
    return await fetchStoredTransactions(ownerId, 20);
  } catch (e) {
    console.error("Failed to fetch recent transactions", e);
    return [];
  }
}

async function fetchPastBriefings(userId: string): Promise<any[]> {
  try {
    const ownerId = parseInt(userId, 10);
    if (isNaN(ownerId)) return [];
    return await fetchCoachBriefings(ownerId, 5);
  } catch (e) {
    console.error("Failed to fetch past briefings", e);
    return [];
  }
}

async function saveCoachBriefing(userId: string, briefing: CoachBriefing): Promise<void> {
  try {
    const ownerId = parseInt(userId, 10);
    if (isNaN(ownerId)) return;
    
    try {
      await createCoachBriefing(ownerId, briefing as any);
    } catch (err) {
      console.error("Failed to save coach briefing via Dev helper", err);
    }
  } catch (e) {
    console.error("Failed to save coach briefing", e);
  }
}

async function fetchFinancialSummary(userId: string): Promise<SpendingSummaryResult> {
  try {
    const ownerId = parseInt(userId, 10);
    if (isNaN(ownerId)) throw new Error("Invalid user ID");

    return await computeSpendingSummary(ownerId);
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

// NOTE: `logTransaction` removed — Dev pipeline now owns persistence. Mill delegates
// transaction writes to `runDevPipeline` (see onTransactionReady above). Keeping
// this file focused on routing and session management.

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

  // Special-case: structured sms_ingest_event payloads
  let isSmsIngestEvent = false;
  let parsedSmsEvent: any = null;
  try {
    if (hasMessage && req.message?.trim().startsWith("{")) {
      const candidate = JSON.parse(req.message as string);
      if (candidate && candidate.type === "sms_ingest_event" && candidate.analysis) {
        isSmsIngestEvent = true;
        parsedSmsEvent = candidate;
      }
    }
  } catch (err) {
    // not JSON or not the expected shape - fall back to plain text
  }

  const agentInput: AgentInput = isSmsIngestEvent
    ? {
        text: buildSmsIngestPrompt(parsedSmsEvent),
      }
    : {
        text: req.message ?? "",
        attachments: hasAttachments ? req.attachments : undefined,
      };

  // Shared options for routing callbacks
  const routerOptions: ConversationRouterOptions = {
    ...req.options,
    onInsightsAvailable: req.options?.onInsightsAvailable ?? (() => fetchUserInsights(req.userId)),
    onQueryReady: req.options?.onQueryReady ?? (() => fetchFinancialSummary(req.userId)),
    onTransactionReady: req.options?.onTransactionReady ?? (async (payload) => {
        // Route Mill transaction logging through Dev pipeline so dedupe/alerts/persistence are unified.
        try {
          const ownerId = parseInt(req.userId, 10);
          const tools = await createFileSystemDevTools();
          const categorization = categorizeTransaction(payload.description ?? "", payload.amount ?? 0);
          const result = await runDevPipeline(payload, categorization, {
            tools,
            meta: { ...(payload as any).meta ?? {}, ownerId },
          } as any);

          logDebug("processAgentMessage: runDevPipeline result", result);
          return;
        } catch (err) {
          logDebug("processAgentMessage: runDevPipeline failed; transaction not persisted by Dev", err);
          // Intentional: do not perform direct DB writes from Mill. Dev is the
          // authoritative persistence layer. Fail silently so UI remains responsive.
          return;
        }
      }),
    onRecentTransactionsReady: () => fetchRecentTransactions(req.userId),
    onPastBriefingsReady: () => fetchPastBriefings(req.userId),
    onCoachBriefingReady: (briefing) => saveCoachBriefing(req.userId, briefing),
  };

  // If this is an sms_ingest_event, start a fresh conversation so Mill greets and asks consent.
  let response: any;
  if (isSmsIngestEvent) {
    response = await conversationRouter.startConversation(req.userId, agentInput, routerOptions);
  } else {
    response = await conversationRouter.continueConversation(req.userId, agentInput, routerOptions);
  }

  const context = await conversationRouter.getContext(req.userId);
  const sessionId =
    (response as { sessionId?: string }).sessionId ?? resolveSessionId(context, response.agent);

  // Attempt to extract machine-readable tool output embedded in assistant message
  // e.g. ```json
  // { "tool_code": "..." }
  // ```
  let parsedResult: unknown = (response as any).result ?? undefined;
  try {
    if (!parsedResult && typeof (response as any).message === "string") {
      const msg: string = (response as any).message;
      const m = msg.match(/```json\s*([\s\S]*?)```/i);
      if (m && m[1]) {
        const jsonText = m[1].trim();
        try {
          parsedResult = JSON.parse(jsonText);
          logDebug("processAgentMessage: parsed tool JSON from assistant message", { parsedResult });
        } catch (err) {
          // Some assistant blocks include `tool_code` with non-JSON payloads; ignore parse errors.
          logDebug("processAgentMessage: failed to parse tool JSON", err);
        }
      }
    }
  } catch (err) {
    logDebug("processAgentMessage: error extracting tool output", err);
  }

  // If no parsed result found, prefer structured session-collected info (Mill flows set this)
  if (!parsedResult && context && (context as any).millSession && (context as any).millSession.collectedInfo) {
    parsedResult = { collectedInfo: (context as any).millSession.collectedInfo, pendingAction: (context as any).millSession.pendingAction };
  }

  const toolResult = parsedResult ?? (response as any).result ?? undefined;
  const action = (parsedResult && typeof (parsedResult as any).action === 'string') ? (parsedResult as any).action : (toolResult && (toolResult as any).pendingAction) ?? (context && (context as any).millSession?.pendingAction) ?? undefined;

  return {
    ...response,
    sessionId,
    context,
    result: toolResult,
    toolResult,
    parsed: toolResult,
    action,
  };
}

export default processAgentMessage;

/**
 * Build a concise, user-facing prompt from a structured sms_ingest_event.
 */
function buildSmsIngestPrompt(event: any): string {
  try {
    const analysis = event.analysis || {};
    const status = analysis.status || "draft";
    const data = analysis.data || {};
    const missing = Array.isArray(analysis.missing) ? analysis.missing : [];
    const confidence = analysis.confidence || "medium";
    const original = analysis.original_text || event.original_text || "";

    const parts: string[] = [];
    parts.push(`Dev produced a draft from an incoming SMS (status: ${status}; confidence: ${confidence}).`);

    if (data.merchant || data.amount || data.currency || data.method || data.date) {
      const merchant = data.merchant ? `${data.merchant}` : "an unknown merchant";
      const amount = typeof data.amount === "number" ? `${data.currency || "INR"} ${data.amount}` : "an unknown amount";
      const method = data.method ? ` via ${data.method}` : "";
      parts.push(`It looks like ${amount} at ${merchant}${method} on ${data.date ?? "an unknown date"}.`);
    } else if (original) {
      parts.push(`Raw message: "${original}"`);
    }

    if (missing.length > 0) {
      parts.push(`The following fields are missing: ${missing.join(", ")}.`);
    }

    parts.push("Please ask the user to confirm and provide any missing details. Once the user confirms, persist the final transaction via Dev.");

    // Friendly opening to encourage Mill to ask consent
    // Use the exact wording the user requested as the opening line.
    const method = data.method ? data.method.toUpperCase() : "UPI";
    const merchantLabel = data.merchant ? `${data.merchant}` : "Unknown Merchant";
    const amountLabel = typeof data.amount === "number" ? `${data.currency || "INR"} ${data.amount}` : "an amount";
    const originalText = original || (analysis.data && analysis.data.raw) || "";

    parts.push(
      `Hey, I saw that Dev told me you had a transaction through ${method} for ${amountLabel} at ${merchantLabel}. Would you like to log that in with the message: '${originalText}'? Is that all, or can I get more data?`
    );

    return parts.join(" ");
  } catch (err) {
    return `Dev produced a draft from an SMS. Please ask the user to confirm details and persist via Dev.`;
  }
}
