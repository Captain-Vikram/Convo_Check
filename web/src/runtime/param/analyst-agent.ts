import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "../../../../data/generated/prisma";
import { logger } from "../shared/logger";
import { analystAgent } from "@/agents/analyst";
import { loadTransactions } from "./transactions-loader";
import type { NormalizedTransaction } from "../dev/transaction-normalizer";
import { callLLM } from "../shared/llm-client";
import { prisma } from "@/lib/prisma";

interface CategoryStat {
  category: string;
  count: number;
  totalSpend: number;
}

interface DirectionStat {
  direction: NormalizedTransaction["direction"];
  count: number;
  totalAmount: number;
}

interface WeekdayStat {
  weekday: string;
  count: number;
  expenseAmount: number;
}

interface TagStat {
  tag: string;
  count: number;
}

interface FlavorStat {
  flavor: NormalizedTransaction["flavor"];
  count: number;
}

interface CounterpartyStat {
  targetParty: string;
  count: number;
  expenseAmount: number;
}

interface SummaryTransaction {
  id: string;
  direction: NormalizedTransaction["direction"];
  amount: number;
  currency: string;
  category: string;
  flavor: NormalizedTransaction["flavor"];
  description: string;
  recordedAt: string;
  eventDate?: string;
  eventTime?: string;
  targetParty?: string;
  tags: string[];
  structuredSummary: string;
}

interface AnalysisStats {
  totalTransactions: number;
  totalExpense: number;
  totalIncome: number;
  averageTransactionAmount: number;
  expenseShare: number;
  categoryByCount: CategoryStat[];
  categoryBySpend: CategoryStat[];
  directionStats: DirectionStat[];
  weekdayStats: WeekdayStat[];
  tagStats: TagStat[];
  flavorStats: FlavorStat[];
  counterpartyStats: CounterpartyStat[];
  last30DayTransactions: number;
  last30DayExpenseTotal: number;
  last30DayIncomeTotal: number;
  savingsRate30d: number;
  currencyUsage: string[];
  largestTransactions: SummaryTransaction[];
  recentTransactions: SummaryTransaction[];
}

export interface HabitInsight {
  habitLabel: string;
  evidence: string;
  counsel: string;
  fullText: string;
}

export interface RunAnalystOptions {
  /** If true, re-analyze all transactions regardless of analyzed_at status */
  reanalyzeAll?: boolean;
  /** If true, only return count without actually running analysis */
  dryRun?: boolean;
  /** Optional user ID for multi-user filtering (defaults to DEV_USER_ID) */
  ownerId?: number;
  /** Trigger source for logging/scheduling */
  trigger?: "manual" | "chatur" | "daily";
}

export interface AnalystRunResult {
  status: "success" | "skipped" | "error";
  totalTransactions: number;
  analyzedTransactions: number;
  insightsGenerated: number;
  insightsSuperseded: number;
  insightsUpdated: number;
  newInsightsAvailable: boolean;
  message: string;
  cursor?: HabitProcessingCursorState | null;
  error?: Error;
}

interface HabitProcessingCursorState {
  owner: number;
  lastTransactionAt: Date | null;
  lastRunAt: Date | null;
  lastTrigger?: string | null;
  lastAnalysisVersion?: number | null;
}

/** Current version of analysis logic - increment when model/logic changes */
const ANALYSIS_VERSION = 1;
const HOURS_IN_MS = 60 * 60 * 1000;

function parseRateLimitWindow(perDayRaw?: string, hoursRaw?: string, fallbackHours = 24): number {
  if (perDayRaw) {
    const parsed = Number(perDayRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max((24 / parsed) * HOURS_IN_MS, HOURS_IN_MS);
    }
  }

  if (hoursRaw) {
    const parsed = Number(hoursRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(parsed * HOURS_IN_MS, HOURS_IN_MS);
    }
  }

  return fallbackHours * HOURS_IN_MS;
}

function getParamRateLimitMs(): number {
  return parseRateLimitWindow(
    process.env.PARAM_MAX_RUNS_PER_DAY ?? process.env.MAX_RUNS_PER_DAY,
    process.env.PARAM_RATE_LIMIT_HOURS,
    24,
  );
}

interface StoredHabitInsight extends HabitInsight {
  id: number;
  habitId: string;
  superseded: boolean;
}

function resolveOwnerId(ownerId?: number): number {
  if (typeof ownerId === "number" && Number.isFinite(ownerId)) {
    return ownerId;
  }

  const configured = process.env.DEV_USER_ID ? parseInt(process.env.DEV_USER_ID, 10) : NaN;
  return Number.isFinite(configured) ? configured : 1;
}

export async function runAnalyst(options: RunAnalystOptions = {}): Promise<AnalystRunResult> {
  const { reanalyzeAll = false, dryRun = false } = options;
  const ownerId = resolveOwnerId(options.ownerId);
  const trigger = options.trigger ?? "manual";

  logger.debug("analyst-agent", "Starting analyst run", { ownerId, reanalyzeAll, dryRun, trigger });

  const cursor = await loadProcessingCursor(ownerId);
  const transactions = await loadTransactions();

  if (transactions.length === 0) {
    return handleEmptyHistory(dryRun);
  }

  const lastProcessedAt = reanalyzeAll ? undefined : cursor?.lastTransactionAt ?? null;
  const transactionsToAnalyze = selectTransactionsForAnalysis(transactions, lastProcessedAt, reanalyzeAll);

  const lastRunAt = cursor?.lastRunAt ?? null;
  const withinRateLimit = Boolean(
    lastRunAt &&
    Date.now() - lastRunAt.getTime() < getParamRateLimitMs() &&
    trigger !== "manual" &&
    !reanalyzeAll,
  );

  if (withinRateLimit && transactionsToAnalyze.length === 0) {
    return {
      status: "skipped",
      totalTransactions: transactions.length,
      analyzedTransactions: 0,
      insightsGenerated: 0,
      insightsSuperseded: 0,
      insightsUpdated: 0,
      newInsightsAvailable: false,
      message: `Rate limited: last run at ${lastRunAt?.toISOString() ?? "unknown"}`,
      cursor,
    };
  }

  if (transactionsToAnalyze.length === 0 && !reanalyzeAll) {
    return {
      status: "skipped",
      totalTransactions: transactions.length,
      analyzedTransactions: 0,
      insightsGenerated: 0,
      insightsSuperseded: 0,
      insightsUpdated: 0,
      newInsightsAvailable: false,
      message: lastProcessedAt
        ? `No new transactions since ${lastProcessedAt.toISOString()}`
        : "No eligible transactions to analyze",
      cursor,
    };
  }

  logger.debug("analyst-agent", "Analyzing transactions", {
    ownerId,
    total: transactions.length,
    toAnalyze: transactionsToAnalyze.length,
    reanalyzeAll,
    version: ANALYSIS_VERSION,
  });

  if (dryRun) {
    return {
      status: "success",
      totalTransactions: transactions.length,
      analyzedTransactions: transactionsToAnalyze.length,
      insightsGenerated: 0,
      insightsSuperseded: 0,
      insightsUpdated: 0,
      newInsightsAvailable: false,
      message: `Dry run: Would analyze ${transactionsToAnalyze.length} of ${transactions.length} transactions`,
      cursor,
    };
  }

  try {
  const previousInsights: StoredHabitInsight[] = await loadExistingInsights(ownerId);
    const stats = buildAnalysisStats(transactionsToAnalyze);
    const prompt = buildAnalystPrompt(stats, previousInsights);
    const rawOutput = await callLanguageModel(prompt);
    const bulletLines = normalizeBulletLines(rawOutput);
    let insights: HabitInsight[];

    try {
      insights = bulletLines.map(parseHabitInsight);
    } catch (error) {
      logger.error("analyst-agent", "Failed to parse bullet lines", error, { bulletLines });
      throw error;
    }

    const persistenceResult = await persistInsightsToDatabase(ownerId, insights, previousInsights);
    await persistHabitSnapshot({
      ownerId,
      stats,
      insights,
      transactions: transactionsToAnalyze,
      previousInsights,
      trigger,
    });
    logger.debug("analyst-agent", "Persisted insights", persistenceResult);

    if (transactionsToAnalyze.length > 0) {
      await markTransactionsAsAnalyzed(transactionsToAnalyze, ANALYSIS_VERSION);
      logger.debug(
        "analyst-agent",
        `Marked ${transactionsToAnalyze.length} transactions as analyzed (v${ANALYSIS_VERSION})`,
      );
    }

    const latestTransactionAt = getLatestTransactionTimestamp(transactionsToAnalyze) ?? lastProcessedAt ?? null;
    const updatedCursor = await saveProcessingCursor(ownerId, {
      lastTransactionAt: latestTransactionAt,
      lastRunAt: new Date(),
      lastTrigger: trigger,
      lastAnalysisVersion: ANALYSIS_VERSION,
    });

    return {
      status: "success",
      totalTransactions: transactions.length,
      analyzedTransactions: transactionsToAnalyze.length,
      insightsGenerated: persistenceResult.created,
      insightsSuperseded: persistenceResult.superseded,
      insightsUpdated: persistenceResult.updated,
      newInsightsAvailable:
        persistenceResult.created > 0 ||
        persistenceResult.superseded > 0 ||
        persistenceResult.updated > 0,
      message: `Analyzed ${transactionsToAnalyze.length} transactions, generated ${persistenceResult.created} insights`,
      cursor: updatedCursor,
    };
  } catch (error) {
    logger.error("analyst-agent", "Analysis failed", error);
    return {
      status: "error",
      totalTransactions: transactions.length,
      analyzedTransactions: 0,
      insightsGenerated: 0,
      insightsSuperseded: 0,
      insightsUpdated: 0,
      newInsightsAvailable: false,
      message: `Analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      cursor,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function handleEmptyHistory(dryRun: boolean): AnalystRunResult {
  return {
    status: "skipped",
    totalTransactions: 0,
    analyzedTransactions: 0,
    insightsGenerated: 0,
    insightsSuperseded: 0,
    insightsUpdated: 0,
    newInsightsAvailable: false,
    message: dryRun ? "Dry run: no transactions available" : "No transactions available for analysis",
    cursor: null,
  };
}

function selectTransactionsForAnalysis(
  transactions: NormalizedTransaction[],
  lastProcessedAt?: Date | null,
  reanalyzeAll?: boolean,
): NormalizedTransaction[] {
  if (reanalyzeAll || !lastProcessedAt) {
    return transactions;
  }

  return transactions.filter((tx) => {
    const timestamp = parseTransactionTimestamp(tx);
    if (!timestamp) {
      return false;
    }
    return timestamp > lastProcessedAt;
  });
}

function parseTransactionTimestamp(tx: NormalizedTransaction): Date | null {
  const source = tx.recordedAt ?? tx.eventDate ?? null;
  if (!source) {
    return null;
  }

  const timestamp = new Date(source);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function getLatestTransactionTimestamp(transactions: NormalizedTransaction[]): Date | null {
  let latest: Date | null = null;
  for (const tx of transactions) {
    const timestamp = parseTransactionTimestamp(tx);
    if (!timestamp) {
      continue;
    }
    if (!latest || timestamp > latest) {
      latest = timestamp;
    }
  }
  return latest;
}

async function loadProcessingCursor(ownerId: number): Promise<HabitProcessingCursorState | null> {
  try {
    const record = await prisma.habit_processing_cursors.findUnique({ where: { owner: ownerId } });
    return record ? mapCursorRecord(record) : null;
  } catch (error) {
    logger.error("analyst-agent", "Failed to load processing cursor", error, { ownerId });
    return null;
  }
}

async function saveProcessingCursor(
  ownerId: number,
  data: Partial<HabitProcessingCursorState>,
): Promise<HabitProcessingCursorState> {
  const payload = {
    last_transaction_at: data.lastTransactionAt ?? null,
    last_run_at: data.lastRunAt ?? new Date(),
    last_trigger: data.lastTrigger ?? null,
    last_analysis_version: data.lastAnalysisVersion ?? null,
  };

  const record = await prisma.habit_processing_cursors.upsert({
    where: { owner: ownerId },
    update: payload,
    create: {
      owner: ownerId,
      created_at: new Date(),
      ...payload,
    },
  });

  return mapCursorRecord(record);
}

function mapCursorRecord(record: any): HabitProcessingCursorState {
  return {
    owner: record.owner,
    lastTransactionAt: record.last_transaction_at ? new Date(record.last_transaction_at) : null,
    lastRunAt: record.last_run_at ? new Date(record.last_run_at) : null,
    lastTrigger: record.last_trigger,
    lastAnalysisVersion: record.last_analysis_version,
  };
}

/**
 * Mark transactions as analyzed by updating their metadata via API
 */
async function markTransactionsAsAnalyzed(
  transactions: NormalizedTransaction[],
  version: number,
): Promise<void> {
  const serviceToken = process.env.SERVICE_API_TOKEN;
  const baseUrl = process.env.MILL_API_BASE_URL ?? "http://localhost:3000";
  const analyzedAt = new Date().toISOString();

  for (const tx of transactions) {
    try {
      const response = await fetch(`${baseUrl}/api/transactions/${tx.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {}),
        },
        body: JSON.stringify({
          analyzed_at: analyzedAt,
          analyzed_version: version,
          analysis_notes: `Analyzed by param agent v${version}`,
        }),
      });

      if (!response.ok) {
        logger.debug("analyst-agent", `Failed to mark transaction ${tx.id} as analyzed`, {
          status: response.status,
          statusText: response.statusText,
        });
      }
    } catch (error) {
      logger.error("analyst-agent", `Error marking transaction ${tx.id} as analyzed`, error);
    }
  }
}

function buildAnalysisStats(transactions: NormalizedTransaction[]): AnalysisStats {
  const categoryMap = new Map<string, { count: number; totalSpend: number }>();
  const directionMap = new Map<NormalizedTransaction["direction"], { count: number; totalAmount: number }>();
  const weekdayMap = new Map<string, { count: number; expenseAmount: number }>();
  const tagMap = new Map<string, number>();
  const flavorMap = new Map<NormalizedTransaction["flavor"], number>();
  const counterpartyMap = new Map<string, { count: number; expenseAmount: number }>();
  const currencySet = new Set<string>();

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime());
  thirtyDaysAgo.setDate(now.getDate() - 30);

  let totalExpense = 0;
  let totalIncome = 0;
  let last30DayTransactions = 0;
  let last30DayExpenseTotal = 0;
  let last30DayIncomeTotal = 0;

  for (const transaction of transactions) {
    currencySet.add(transaction.currency);

    const categoryKey = transaction.category || "Uncategorized";
    const categoryState = categoryMap.get(categoryKey) ?? { count: 0, totalSpend: 0 };
    categoryState.count += 1;
    if (transaction.direction === "expense") {
      categoryState.totalSpend += transaction.amount;
    }
    categoryMap.set(categoryKey, categoryState);

    const directionState = directionMap.get(transaction.direction) ?? { count: 0, totalAmount: 0 };
    directionState.count += 1;
    directionState.totalAmount += transaction.amount;
    directionMap.set(transaction.direction, directionState);

    flavorMap.set(transaction.flavor, (flavorMap.get(transaction.flavor) ?? 0) + 1);

    const eventMoment = resolveEventMoment(transaction) ?? toDate(transaction.recordedAt);
    const weekday = eventMoment
      ? eventMoment.toLocaleDateString("en-US", { weekday: "long" })
      : "Unknown";
    const weekdayState = weekdayMap.get(weekday) ?? { count: 0, expenseAmount: 0 };
    weekdayState.count += 1;
    if (transaction.direction === "expense") {
      weekdayState.expenseAmount += transaction.amount;
    }
    weekdayMap.set(weekday, weekdayState);

    if (eventMoment && eventMoment >= thirtyDaysAgo) {
      last30DayTransactions += 1;
      if (transaction.direction === "expense") {
        last30DayExpenseTotal += transaction.amount;
      } else if (transaction.direction === "income") {
        last30DayIncomeTotal += transaction.amount;
      }
    }

    if (transaction.direction === "expense") {
      totalExpense += transaction.amount;
    } else {
      totalIncome += transaction.amount;
    }

    for (const tag of transaction.tags) {
      tagMap.set(tag, (tagMap.get(tag) ?? 0) + 1);
    }

    if (transaction.meta.targetParty) {
      const key = transaction.meta.targetParty;
      const counterpartyState = counterpartyMap.get(key) ?? { count: 0, expenseAmount: 0 };
      counterpartyState.count += 1;
      if (transaction.direction === "expense") {
        counterpartyState.expenseAmount += transaction.amount;
      }
      counterpartyMap.set(key, counterpartyState);
    }
  }

  const averageTransactionAmount =
    transactions.length > 0 ? (totalExpense + totalIncome) / transactions.length : 0;
  const expenseShare =
    totalExpense + totalIncome > 0 ? totalExpense / (totalExpense + totalIncome) : 0;
  const savingsRate30d =
    last30DayIncomeTotal > 0
      ? (last30DayIncomeTotal - last30DayExpenseTotal) / last30DayIncomeTotal
      : 0;

  const categoryEntries = Array.from(categoryMap.entries()).map(([category, value]) => ({
    category,
    count: value.count,
    totalSpend: value.totalSpend,
  }));
  const categoryByCount = [...categoryEntries].sort((a, b) => b.count - a.count);
  const categoryBySpend = [...categoryEntries].sort((a, b) => b.totalSpend - a.totalSpend);

  const directionStats = Array.from(directionMap.entries()).map(([direction, value]) => ({
    direction,
    count: value.count,
    totalAmount: value.totalAmount,
  }));

  const weekdayStats = Array.from(weekdayMap.entries()).map(([weekday, value]) => ({
    weekday,
    count: value.count,
    expenseAmount: value.expenseAmount,
  }));
  weekdayStats.sort((a, b) => b.count - a.count);

  const tagStats = Array.from(tagMap.entries()).map(([tag, count]) => ({ tag, count }));
  tagStats.sort((a, b) => b.count - a.count);

  const flavorStats = Array.from(flavorMap.entries()).map(([flavor, count]) => ({
    flavor,
    count,
  }));
  flavorStats.sort((a, b) => b.count - a.count);

  const counterpartyStats = Array.from(counterpartyMap.entries()).map(([targetParty, value]) => ({
    targetParty,
    count: value.count,
    expenseAmount: value.expenseAmount,
  }));
  counterpartyStats.sort((a, b) => b.expenseAmount - a.expenseAmount);

  const currencyUsage = Array.from(currencySet).sort();

  const largestTransactions = pickLargestTransactions(transactions, 5);
  const recentTransactions = pickMostRecentTransactions(transactions, 5);

  return {
    totalTransactions: transactions.length,
    totalExpense,
    totalIncome,
    averageTransactionAmount,
    expenseShare,
    categoryByCount,
    categoryBySpend,
    directionStats,
    weekdayStats,
    tagStats,
    flavorStats,
    counterpartyStats,
    last30DayTransactions,
    last30DayExpenseTotal,
    last30DayIncomeTotal,
    savingsRate30d,
    currencyUsage,
    largestTransactions,
    recentTransactions,
  };
}

function buildAnalystPrompt(stats: AnalysisStats, previousInsights?: HabitInsight[]): string {
  const payload = buildPromptPayload(stats);
  const lines: string[] = [];
  lines.push("Apply the Insight Protocol to create bullet habit insights for this user.");
  lines.push(
    `Totals (lifetime): ${stats.totalTransactions} transactions | expense ${roundNumber(stats.totalExpense)} | income ${roundNumber(stats.totalIncome)} | avg ticket ${roundNumber(stats.averageTransactionAmount)}.`,
  );
  lines.push(
    `Last 30 days: ${stats.last30DayTransactions} tx | spend ${roundNumber(stats.last30DayExpenseTotal)} | income ${roundNumber(stats.last30DayIncomeTotal)} | savings rate ${roundNumber(stats.savingsRate30d)}.`,
  );
  if (previousInsights && previousInsights.length > 0) {
    lines.push("Previous insights (update or extend these if still relevant):");
    previousInsights.slice(0, 5).forEach((insight, index) => {
      lines.push(`${index + 1}. ${insight.fullText}`);
    });
  }

  lines.push("Ground every insight in the JSON metrics below. Reuse prior insights when still accurate and mark stale ones as superseded.");
  lines.push(
    "Example format: - Dining Discipline | Evidence: Dining spend 42% of expenses | Recommendation: Set a weekly dining cap.",
  );
  lines.push("Metrics JSON:");
  lines.push(JSON.stringify(payload, null, 2));
  return lines.join("\n");
}

function buildPromptPayload(stats: AnalysisStats) {
  return {
    totals: {
      totalTransactions: stats.totalTransactions,
      totalExpense: roundNumber(stats.totalExpense),
      totalIncome: roundNumber(stats.totalIncome),
      averageTransactionAmount: roundNumber(stats.averageTransactionAmount),
      expenseShare: roundNumber(stats.expenseShare),
      currencyUsage: stats.currencyUsage,
    },
    last30d: {
      transactionCount: stats.last30DayTransactions,
      expenseTotal: roundNumber(stats.last30DayExpenseTotal),
      incomeTotal: roundNumber(stats.last30DayIncomeTotal),
      savingsRate: roundNumber(stats.savingsRate30d),
      netCashflow: roundNumber(stats.last30DayIncomeTotal - stats.last30DayExpenseTotal),
    },
    categories: {
      byCount: limitArray(stats.categoryByCount, 5).map((entry) => ({
        category: entry.category,
        count: entry.count,
        totalSpend: roundNumber(entry.totalSpend),
      })),
      bySpend: limitArray(stats.categoryBySpend, 5).map((entry) => ({
        category: entry.category,
        count: entry.count,
        totalSpend: roundNumber(entry.totalSpend),
      })),
    },
    directions: stats.directionStats.map((entry) => ({
      direction: entry.direction,
      count: entry.count,
      totalAmount: roundNumber(entry.totalAmount),
    })),
    weekdays: limitArray(stats.weekdayStats, 7).map((entry) => ({
      weekday: entry.weekday,
      count: entry.count,
      expenseAmount: roundNumber(entry.expenseAmount),
    })),
    tags: limitArray(stats.tagStats, 10),
    flavors: stats.flavorStats,
    counterparties: limitArray(stats.counterpartyStats, 5).map((entry) => ({
      targetParty: entry.targetParty,
      count: entry.count,
      expenseAmount: roundNumber(entry.expenseAmount),
    })),
    largestTransactions: stats.largestTransactions,
    recentTransactions: stats.recentTransactions,
  };
}

async function callLanguageModel(prompt: string): Promise<string> {
  const result = await callLLM("agent3", {
    system: analystAgent.systemPrompt,
    messages: [
      { role: "user", content: prompt },
    ],
  });

  return (result.text ?? "").trim();
}

interface PersistedInsightSummary {
  created: number;
  superseded: number;
  updated: number;
  insightIds: string[];
}

async function persistInsightsToDatabase(
  ownerId: number,
  insights: HabitInsight[],
  previousInsights: StoredHabitInsight[],
): Promise<PersistedInsightSummary> {
  if (insights.length === 0) {
    return { created: 0, superseded: 0, updated: 0, insightIds: [] };
  }

  const now = new Date();
  const activePrevious = previousInsights.filter((insight) => !insight.superseded);
  const previousMap = new Map<string, StoredHabitInsight>();
  for (const insight of activePrevious) {
    const key = normalizeHabitLabel(insight.habitLabel);
    if (key) {
      previousMap.set(key, insight);
    }
  }

  const createdIds: string[] = [];
  let updatedCount = 0;

  for (const insight of insights) {
    const normalizedLabel = normalizeHabitLabel(insight.habitLabel);
    const previousMatch = normalizedLabel ? previousMap.get(normalizedLabel) : undefined;

    if (previousMatch) {
      try {
        await prisma.habit_insights.update({
          where: { id: previousMatch.id },
          data: {
            habit_label: insight.habitLabel,
            evidence: insight.evidence,
            counsel: insight.counsel,
            full_text: insight.fullText,
            updated_at: now,
            superseded: false,
          },
        });
        updatedCount += 1;
        if (normalizedLabel) {
          previousMap.delete(normalizedLabel);
        }
        continue;
      } catch (error) {
        logger.error("analyst-agent", "Failed to update habit insight", error, {
          ownerId,
          habitLabel: insight.habitLabel,
        });
      }
    }

    const habitId = randomUUID();
    try {
      await prisma.habit_insights.create({
        data: {
          owner: ownerId,
          habit_id: habitId,
          habit_label: insight.habitLabel,
          evidence: insight.evidence,
          counsel: insight.counsel,
          full_text: insight.fullText,
          recorded_at: now,
          updated_at: now,
          superseded: false,
          previous_habit_id: previousMatch?.habitId ?? null,
        },
      });
      createdIds.push(habitId);
    } catch (error) {
      logger.error("analyst-agent", "Failed to persist habit insight", error, {
        ownerId,
        habitLabel: insight.habitLabel,
      });
    }
  }

  const remainingPrevious = Array.from(previousMap.values());
  if (remainingPrevious.length > 0) {
    try {
      await prisma.habit_insights.updateMany({
        where: { id: { in: remainingPrevious.map((entry) => entry.id) } },
        data: { superseded: true, updated_at: now },
      });
    } catch (error) {
      logger.error("analyst-agent", "Failed to mark stale insights", error, {
        ownerId,
        count: remainingPrevious.length,
      });
    }
  }

  return {
    created: createdIds.length,
    superseded: remainingPrevious.length,
    updated: updatedCount,
    insightIds: createdIds,
  };
}

interface HabitSnapshotPersistOptions {
  ownerId: number;
  stats: AnalysisStats;
  insights: HabitInsight[];
  transactions: NormalizedTransaction[];
  previousInsights: StoredHabitInsight[];
  trigger: RunAnalystOptions["trigger"] | string;
}

const MAX_CONTEXT_TRANSACTIONS = 25;
const MAX_CONTEXT_INSIGHTS = 10;

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function persistHabitSnapshot(options: HabitSnapshotPersistOptions): Promise<void> {
  if (options.insights.length === 0) {
    return;
  }

  const payload = buildHabitSnapshotPayload(options);

  try {
    await prisma.habit_snapshots.upsert({
      where: { snapshot_id: payload.snapshotId },
      update: {
        context_data: payload.contextData,
        summary_data: payload.summaryData,
        snapshot_hash: payload.snapshotHash,
        generated_at: payload.generatedAt,
        insight_labels: payload.insightLabels,
        insights_count: payload.insightCount,
        status: "Active",
        trigger: options.trigger ?? "manual",
      },
      create: {
        snapshot_id: payload.snapshotId,
        owner: options.ownerId,
        context_data: payload.contextData,
        summary_data: payload.summaryData,
        snapshot_hash: payload.snapshotHash,
        generated_at: payload.generatedAt,
        insight_labels: payload.insightLabels,
        insights_count: payload.insightCount,
        status: "Active",
        trigger: options.trigger ?? "manual",
      },
    });
  } catch (error) {
    logger.error("analyst-agent", "Failed to persist habit snapshot", error, {
      ownerId: options.ownerId,
    });
  }
}

interface HabitSnapshotPayload {
  snapshotId: string;
  snapshotHash: string;
  summaryData: Prisma.InputJsonValue;
  contextData: Prisma.InputJsonValue;
  generatedAt: Date;
  insightLabels: string[];
  insightCount: number;
}

function buildHabitSnapshotPayload(options: HabitSnapshotPersistOptions): HabitSnapshotPayload {
  const generatedAt = new Date();
  const summaryMetrics = buildPromptPayload(options.stats);
  const insightLabels = options.insights.map((insight) => insight.habitLabel);
  const contextTransactions = options.transactions
    .slice(-MAX_CONTEXT_TRANSACTIONS)
    .map(simplifyTransactionForSnapshot);

  const recentInsights = options.insights.slice(0, MAX_CONTEXT_INSIGHTS).map((insight) => ({
    label: insight.habitLabel,
    evidence: insight.evidence,
    counsel: insight.counsel,
  }));

  const priorInsights = options.previousInsights
    .filter((insight) => !insight.superseded)
    .slice(0, MAX_CONTEXT_INSIGHTS)
    .map((insight) => ({
      label: insight.habitLabel,
      counsel: insight.counsel,
    }));

  const summaryData = toJsonValue({
    metrics: summaryMetrics,
    insightsCount: options.insights.length,
    lastRunTrigger: options.trigger ?? "manual",
    analyzedTransactions: options.transactions.length,
  });

  const contextData = toJsonValue({
    ownerId: options.ownerId,
    generatedAt: generatedAt.toISOString(),
    trigger: options.trigger ?? "manual",
    transactionsAnalyzed: contextTransactions,
    recentInsights,
    previousInsights: priorInsights,
  });

  const canonical = {
    ownerId: options.ownerId,
    summaryData,
    contextData,
  };

  const snapshotHash = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");

  return {
    snapshotId: snapshotHash,
    snapshotHash,
    summaryData,
    contextData,
    generatedAt,
    insightLabels,
    insightCount: options.insights.length,
  };
}

function simplifyTransactionForSnapshot(transaction: NormalizedTransaction) {
  return {
    id: transaction.id,
    amount: transaction.amount,
    direction: transaction.direction,
    category: transaction.category,
    recordedAt: transaction.recordedAt ?? transaction.eventDate ?? null,
    targetParty: transaction.meta?.targetParty ?? null,
    tags: transaction.tags,
  };
}

function normalizeHabitLabel(label?: string | null): string | null {
  if (!label) {
    return null;
  }
  const normalized = label.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Load existing insights from database via Prisma
 */
async function loadExistingInsights(ownerId: number): Promise<StoredHabitInsight[]> {
  try {
    const habits = await prisma.habit_insights.findMany({
      where: { owner: ownerId, superseded: false },
      orderBy: { updated_at: "desc" },
    });

    return habits.map((habit) => ({
      id: habit.id,
      habitId: habit.habit_id ?? `habit-${habit.id}`,
      habitLabel: habit.habit_label ?? "",
      evidence: habit.evidence ?? "",
      counsel: habit.counsel ?? "",
      fullText: habit.full_text ?? "",
      superseded: habit.superseded ?? false,
    }));
  } catch (error) {
    logger.error("analyst-agent", "Failed to load habits from DB", error, { ownerId });
    return [];
  }
}

function normalizeBulletLines(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error("Language model returned empty output");
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error("Language model output did not contain any content");
  }

  return lines.map((line) => {
    if (line.startsWith("- ")) {
      return line;
    }
    const stripped = line.replace(/^[-*]\s*/, "");
    return `- ${stripped}`;
  });
}

function parseHabitInsight(line: string): HabitInsight {
  const withoutBullet = line.replace(/^-\s*/, "").trim();

  const structured = parseStructuredFieldInsight(withoutBullet);
  if (structured) {
    return { ...structured, fullText: line };
  }

  const labeled = parseLabelCounselInsight(withoutBullet);
  if (labeled) {
    return { ...labeled, fullText: line };
  }

  const simple = parseSimpleCounselInsight(withoutBullet);
  if (simple) {
    return { ...simple, fullText: line };
  }

  throw new Error(
    "Language model output did not match the expected Habit Label/Evidence/Counsel structure.",
  );
}

function parseStructuredFieldInsight(content: string): Omit<HabitInsight, "fullText"> | null {
  const fieldRegex = /(Habit Label|Habit|Label|Evidence|Counsel|Recommendation)\s*[:\-]\s*/gi;
  const fields: Record<string, string> = {};

  let lastKey: string | null = null;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fieldRegex.exec(content)) !== null) {
    const captured = match[1];
    if (!captured) {
      continue;
    }

    if (lastKey) {
      const rawSegment = content.slice(lastIndex, match.index);
      fields[lastKey] = cleanseValue(rawSegment);
    }

    lastKey = normalizeKey(captured);
    lastIndex = fieldRegex.lastIndex;
  }

  if (lastKey) {
    const finalSegment = content.slice(lastIndex);
    fields[lastKey] = cleanseValue(finalSegment);
  }

  const habitLabel = fields["habit_label"] ?? fields["habit"] ?? fields["label"];
  const evidence = fields["evidence"];
  const counsel = fields["counsel"] ?? fields["recommendation"];

  if (!habitLabel || !evidence || !counsel) {
    return null;
  }

  return {
    habitLabel,
    evidence,
    counsel,
  };
}

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

function cleanseValue(raw: string): string {
  return raw.replace(/^[\s;,\.\-]+/, "").replace(/[\s;,\.\-]+$/, "").trim();
}

function parseLabelCounselInsight(content: string): Omit<HabitInsight, "fullText"> | null {
  const counselRegex = /(?:;|\.)\s*(Counsel|Advice)\s*[:\-]\s*(.+)$/i;
  const counselMatch = counselRegex.exec(content);

  if (!counselMatch) {
    return null;
  }

  const capturedCounsel = counselMatch[2];
  if (!capturedCounsel) {
    return null;
  }

  const counsel = cleanseValue(capturedCounsel);
  const beforeCounsel = content.slice(0, counselMatch.index).trim();
  const colonIndex = beforeCounsel.indexOf(":");

  if (colonIndex === -1) {
    return null;
  }

  let habitLabel = cleanseValue(beforeCounsel.slice(0, colonIndex));
  let evidence = cleanseValue(beforeCounsel.slice(colonIndex + 1));

  if (/^Evidence\s*[:\-]/i.test(evidence)) {
    evidence = cleanseValue(evidence.replace(/^Evidence\s*[:\-]\s*/i, ""));
  }

  if (/^Habit\s*Label\s*[:\-]/i.test(habitLabel)) {
    habitLabel = cleanseValue(habitLabel.replace(/^Habit\s*Label\s*[:\-]\s*/i, ""));
  }

  if (!habitLabel || !evidence || !counsel) {
    return null;
  }

  return {
    habitLabel,
    evidence,
    counsel,
  };
}

function parseSimpleCounselInsight(content: string): Omit<HabitInsight, "fullText"> | null {
  const counselPattern = /counsel\s*[:\-]\s*/i;
  const match = counselPattern.exec(content);
  if (!match) {
    return null;
  }

  const counselStart = match.index + match[0].length;
  const counsel = cleanseValue(content.slice(counselStart));
  const beforeCounsel = cleanseValue(content.slice(0, match.index));

  const firstSeparator = beforeCounsel.indexOf(":");
  if (firstSeparator === -1) {
    return null;
  }

  const habitLabel = cleanseValue(beforeCounsel.slice(0, firstSeparator));
  const evidence = cleanseValue(beforeCounsel.slice(firstSeparator + 1));

  if (!habitLabel || !evidence || !counsel) {
    return null;
  }

  return {
    habitLabel,
    evidence,
    counsel,
  };
}

function pickLargestTransactions(
  transactions: NormalizedTransaction[],
  limit: number,
): SummaryTransaction[] {
  return transactions
    .slice()
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit)
    .map(summarizeTransaction);
}

function pickMostRecentTransactions(
  transactions: NormalizedTransaction[],
  limit: number,
): SummaryTransaction[] {
  return transactions
    .slice()
    .sort((a, b) => {
      const left = resolveSortMoment(a);
      const right = resolveSortMoment(b);
      return right - left;
    })
    .slice(0, limit)
    .map(summarizeTransaction);
}

function summarizeTransaction(transaction: NormalizedTransaction): SummaryTransaction {
  const summary: SummaryTransaction = {
    id: transaction.id,
    direction: transaction.direction,
    amount: roundNumber(transaction.amount),
    currency: transaction.currency,
    category: transaction.category,
    flavor: transaction.flavor,
    description: transaction.description,
    recordedAt: transaction.recordedAt,
    tags: transaction.tags,
    structuredSummary: transaction.structuredSummary,
  };

  if (transaction.eventDate) {
    summary.eventDate = transaction.eventDate;
  }

  if (transaction.eventTime) {
    summary.eventTime = transaction.eventTime;
  }

  if (transaction.meta.targetParty) {
    summary.targetParty = transaction.meta.targetParty;
  }

  return summary;
}

function resolveSortMoment(transaction: NormalizedTransaction): number {
  const recorded = toDate(transaction.recordedAt);
  if (recorded) {
    return recorded.getTime();
  }
  const eventMoment = resolveEventMoment(transaction);
  if (eventMoment) {
    return eventMoment.getTime();
  }
  return 0;
}

function resolveEventMoment(transaction: NormalizedTransaction): Date | undefined {
  if (transaction.eventDate && transaction.eventTime) {
    const candidate = `${transaction.eventDate}T${transaction.eventTime}`;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }

  if (transaction.eventDate) {
    const parsed = Date.parse(transaction.eventDate);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }

  return undefined;
}

function toDate(value?: string): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return new Date(parsed);
}

function limitArray<T>(entries: T[], limit: number): T[] {
  return entries.slice(0, Math.max(limit, 0));
}

function roundNumber(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
}

runAnalyst().catch((error) => {
  console.error("[analyst] Failed to generate habits narrative", error);
  process.exitCode = 1;
});
