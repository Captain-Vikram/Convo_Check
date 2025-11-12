import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getUserContext } from "@/lib/auth-middleware";

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function coerceString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function coerceArrayOfObjects(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      try {
        return JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") {
      return true;
    }
    if (lowered === "false") {
      return false;
    }
  }
  return undefined;
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : null))
    .filter((entry): entry is string => !!entry);
}

interface SanitizedSnapshotInsight {
  habitLabel: string;
  evidence?: string;
  counsel?: string;
  fullText?: string;
  habitId?: string;
  insightId?: number;
  confidence?: number;
  recordedAt?: string;
}

function sanitizeInsights(value: unknown): SanitizedSnapshotInsight[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const habitLabel = coerceString(record.habitLabel ?? record.label ?? record.title);
      if (!habitLabel) {
        return null;
      }

      const habitId = coerceString(record.habitId ?? record.habit_id);
      const insightIdCandidate = coerceNumber(record.insightId ?? record.insight_id ?? record.id);
      const confidenceCandidate = coerceNumber(record.confidence);
      const recordedAt = coerceString(record.recordedAt ?? record.recorded_at);

      const sanitized: SanitizedSnapshotInsight = { habitLabel };

      const evidence = coerceString(record.evidence);
      if (evidence) {
        sanitized.evidence = evidence;
      }

      const counsel = coerceString(record.counsel);
      if (counsel) {
        sanitized.counsel = counsel;
      }

      const fullText = coerceString(record.fullText ?? record.description);
      if (fullText) {
        sanitized.fullText = fullText;
      }

      if (habitId) {
        sanitized.habitId = habitId;
      }

      if (insightIdCandidate !== undefined) {
        sanitized.insightId = Math.trunc(insightIdCandidate);
      }

      if (confidenceCandidate !== undefined) {
        sanitized.confidence = confidenceCandidate;
      }

      if (recordedAt) {
        sanitized.recordedAt = recordedAt;
      }

      return sanitized;
    })
    .filter((entry): entry is SanitizedSnapshotInsight => entry !== null);
}

function sanitizeContextData(value: unknown, owner: number, snapshotId: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      owner,
      snapshotId,
      generatedAt: new Date().toISOString(),
    };
  }

  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {
    owner,
    snapshotId,
  };

  const transactionId = coerceString(record.transactionId ?? record.txId);
  if (transactionId) {
    sanitized.transactionId = transactionId;
  }

  const ownerPhone = coerceString(record.ownerPhone);
  if (ownerPhone) {
    sanitized.ownerPhone = ownerPhone;
  }

  const generatedAtRaw = coerceString(record.generatedAt);
  sanitized.generatedAt = generatedAtRaw && !Number.isNaN(Date.parse(generatedAtRaw))
    ? new Date(generatedAtRaw).toISOString()
    : new Date().toISOString();

  const transactionsSource = record.transactions ?? record.contextTransactions;
  const transactions = coerceArrayOfObjects(transactionsSource);
  if (transactions.length > 0) {
    sanitized.transactions = transactions;
  }

  const habitsSource = record.habits ?? record.contextHabits;
  const habits = coerceArrayOfObjects(habitsSource);
  if (habits.length > 0) {
    sanitized.habits = habits;
  }

  const topCategories = coerceArrayOfObjects(record.topCategories);
  if (topCategories.length > 0) {
    sanitized.topCategories = topCategories;
  }

  const frequentMerchants = coerceArrayOfObjects(record.frequentMerchants);
  if (frequentMerchants.length > 0) {
    sanitized.frequentMerchants = frequentMerchants;
  }

  const spendingByMedium = coerceArrayOfObjects(record.spendingByMedium);
  if (spendingByMedium.length > 0) {
    sanitized.spendingByMedium = spendingByMedium;
  }

  const mostActiveTime = coerceString(record.mostActiveTime);
  if (mostActiveTime) {
    sanitized.mostActiveTime = mostActiveTime;
  }

  const mostActiveDay = coerceString(record.mostActiveDay);
  if (mostActiveDay) {
    sanitized.mostActiveDay = mostActiveDay;
  }

  const isOverspending = coerceBoolean(record.isOverspending);
  if (isOverspending !== undefined) {
    sanitized.isOverspending = isOverspending;
  }

  const hasRecurringPayments = coerceBoolean(record.hasRecurringPayments);
  if (hasRecurringPayments !== undefined) {
    sanitized.hasRecurringPayments = hasRecurringPayments;
  }

  const showsImpulseBuying = coerceBoolean(record.showsImpulseBuying);
  if (showsImpulseBuying !== undefined) {
    sanitized.showsImpulseBuying = showsImpulseBuying;
  }

  const needsBudgetAlert = coerceBoolean(record.needsBudgetAlert);
  if (needsBudgetAlert !== undefined) {
    sanitized.needsBudgetAlert = needsBudgetAlert;
  }

  const behaviorSummary = coerceString(record.behaviorSummary);
  if (behaviorSummary) {
    sanitized.behaviorSummary = behaviorSummary;
  }

  const recommendations = coerceStringArray(record.recommendations);
  if (recommendations.length > 0) {
    sanitized.recommendations = recommendations;
  }

  const insights = sanitizeInsights(record.insights ?? record.contextInsights);
  if (insights.length > 0) {
    sanitized.insights = insights;
  }

  const flags = ensureStringArray(record.flags);
  if (flags.length > 0) {
    sanitized.flags = flags;
  }

  return sanitized;
}

function sanitizeSummaryData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  const totalDebits = coerceNumber(record.totalDebits);
  if (totalDebits !== undefined) {
    sanitized.totalDebits = totalDebits;
  }

  const totalCredits = coerceNumber(record.totalCredits);
  if (totalCredits !== undefined) {
    sanitized.totalCredits = totalCredits;
  }

  const netBalance = coerceNumber(record.netBalance);
  if (netBalance !== undefined) {
    sanitized.netBalance = netBalance;
  }

  const transactionCount = coerceNumber(record.transactionCount);
  if (transactionCount !== undefined) {
    sanitized.transactionCount = transactionCount;
  }

  const averageTransactionSize = coerceNumber(record.averageTransactionSize);
  if (averageTransactionSize !== undefined) {
    sanitized.averageTransactionSize = averageTransactionSize;
  }

  const largestTransaction = coerceNumber(record.largestTransaction);
  if (largestTransaction !== undefined) {
    sanitized.largestTransaction = largestTransaction;
  }

  const smallestTransaction = coerceNumber(record.smallestTransaction);
  if (smallestTransaction !== undefined) {
    sanitized.smallestTransaction = smallestTransaction;
  }

  const topCategories = coerceArrayOfObjects(record.topCategories);
  if (topCategories.length > 0) {
    sanitized.topCategories = topCategories;
  }

  const frequentMerchants = coerceArrayOfObjects(record.frequentMerchants);
  if (frequentMerchants.length > 0) {
    sanitized.frequentMerchants = frequentMerchants;
  }

  const spendingByMedium = coerceArrayOfObjects(record.spendingByMedium);
  if (spendingByMedium.length > 0) {
    sanitized.spendingByMedium = spendingByMedium;
  }

  const mostActiveTime = coerceString(record.mostActiveTime);
  if (mostActiveTime) {
    sanitized.mostActiveTime = mostActiveTime;
  }

  const mostActiveDay = coerceString(record.mostActiveDay);
  if (mostActiveDay) {
    sanitized.mostActiveDay = mostActiveDay;
  }

  const behaviorSummary = coerceString(record.behaviorSummary);
  if (behaviorSummary) {
    sanitized.behaviorSummary = behaviorSummary;
  }

  const recommendations = coerceStringArray(record.recommendations);
  if (recommendations.length > 0) {
    sanitized.recommendations = recommendations;
  }

  const isOverspending = coerceBoolean(record.isOverspending);
  if (isOverspending !== undefined) {
    sanitized.isOverspending = isOverspending;
  }

  const hasRecurringPayments = coerceBoolean(record.hasRecurringPayments);
  if (hasRecurringPayments !== undefined) {
    sanitized.hasRecurringPayments = hasRecurringPayments;
  }

  const showsImpulseBuying = coerceBoolean(record.showsImpulseBuying);
  if (showsImpulseBuying !== undefined) {
    sanitized.showsImpulseBuying = showsImpulseBuying;
  }

  const needsBudgetAlert = coerceBoolean(record.needsBudgetAlert);
  if (needsBudgetAlert !== undefined) {
    sanitized.needsBudgetAlert = needsBudgetAlert;
  }

  const insightsCount = coerceNumber(record.insightsCount ?? record.insightCount);
  if (insightsCount !== undefined) {
    sanitized.insightsCount = Math.max(0, Math.trunc(insightsCount));
  }

  const insightLabels = ensureStringArray(record.insightLabels ?? record.labels);
  if (insightLabels.length > 0) {
    sanitized.insightLabels = insightLabels;
  }

  const flags = ensureStringArray(record.flags);
  if (flags.length > 0) {
    sanitized.flags = flags;
  }

  return sanitized;
}

interface SnapshotMetadata {
  generatedAt: Date;
  transactionId: string | null;
  topCategories?: unknown;
  frequentMerchants?: unknown;
  spendingByMedium?: unknown;
  flags: string[];
  insightsCount: number;
  insightLabels: string[];
  snapshotHash: string;
}

function extractBooleanFlags(context: Record<string, unknown>, summary: Record<string, unknown>): string[] {
  const flagKeys = ["isOverspending", "hasRecurringPayments", "showsImpulseBuying", "needsBudgetAlert"];
  const flagSet = new Set<string>(ensureStringArray(context.flags).concat(ensureStringArray(summary.flags)));

  for (const key of flagKeys) {
    if (context[key] === true || summary[key] === true) {
      flagSet.add(key);
    }
  }

  return Array.from(flagSet);
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed);
}

function deriveSnapshotMetadata(
  context: Record<string, unknown>,
  summary: Record<string, unknown>,
  insights: SanitizedSnapshotInsight[],
): SnapshotMetadata {
  const generatedAtSource = parseIsoDate(context.generatedAt) ?? parseIsoDate(summary.generatedAt);
  const generatedAt = generatedAtSource ?? new Date();

  const transactionId = coerceString(context.transactionId ?? summary.transactionId) ?? null;

  const topCategories = context.topCategories ?? summary.topCategories;
  const frequentMerchants = context.frequentMerchants ?? summary.frequentMerchants;
  const spendingByMedium = context.spendingByMedium ?? summary.spendingByMedium;

  const insightLabels = Array.isArray(summary.insightLabels)
    ? ensureStringArray(summary.insightLabels)
    : insights.map((entry) => entry.habitLabel).filter((label) => label.length > 0);

  const insightsCount = typeof summary.insightsCount === "number" && Number.isFinite(summary.insightsCount)
    ? Math.trunc(summary.insightsCount)
    : insights.length;

  const flags = extractBooleanFlags(context, summary);

  const hashPayload = {
    owner: context.owner ?? null,
    snapshotId: context.snapshotId ?? null,
    transactionId,
    insightLabels: [...insightLabels].sort(),
    flags: [...flags].sort(),
  };

  const snapshotHash = createHash("sha256").update(JSON.stringify(hashPayload)).digest("hex");

  return {
    generatedAt,
    transactionId,
    topCategories,
    frequentMerchants,
    spendingByMedium,
    flags,
    insightsCount,
    insightLabels,
    snapshotHash,
  };
}

function extractInsightIdsFromArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (typeof entry === "number" && Number.isFinite(entry)) {
        return Math.trunc(entry);
      }
      if (typeof entry === "string") {
        const parsed = Number.parseInt(entry, 10);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      return null;
    })
    .filter((entry): entry is number => entry !== null);
}

function mergeInsightIdSources(
  owner: number,
  contextInsights: SanitizedSnapshotInsight[],
  initialIds: number[],
): Promise<number[]> {
  const resolvedIds = new Set<number>(initialIds);

  const lookups = contextInsights.map(async (insight) => {
    if (typeof insight.insightId === "number" && Number.isFinite(insight.insightId)) {
      resolvedIds.add(Math.trunc(insight.insightId));
      return;
    }

    if (!insight.habitId || resolvedIdsHas(resolvedIds, insight.insightId)) {
      return;
    }

    const match = await prisma.habit_insights.findFirst({
      where: {
        owner,
        habit_id: insight.habitId,
      },
      select: { id: true },
      orderBy: { recorded_at: "desc" },
    });

    if (match) {
      resolvedIds.add(match.id);
    }
  });

  return Promise.all(lookups).then(() => Array.from(resolvedIds));
}

function resolvedIdsHas(set: Set<number>, candidate: number | undefined): boolean {
  if (candidate === undefined) {
    return false;
  }
  return set.has(Math.trunc(candidate));
}

function extractContextInsights(context: Record<string, unknown>): SanitizedSnapshotInsight[] {
  const value = context.insights;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is SanitizedSnapshotInsight => !!entry && typeof entry === "object");
}

function synchronizeBooleanField(
  context: Record<string, unknown>,
  summary: Record<string, unknown>,
  key: string,
): void {
  const candidates = [context[key], summary[key]];
  const resolved = candidates.find((value): value is boolean => typeof value === "boolean");
  if (resolved === undefined) {
    return;
  }
  context[key] = resolved;
  summary[key] = resolved;
}

/**
 * POST /api/habit-snapshots - Create new habit snapshot
 * Used by habit-tracker to sync snapshots to database
 */
export async function POST(request: Request) {
  try {
    const userContext = await getUserContext(request);

    if (!userContext) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);

    if (!body) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Log received data for debugging
    console.log("[habit-snapshots] Received POST:", {
      snapshotId: body.snapshotId,
      owner: body.owner,
      hasContextData: !!body.contextData,
      hasSummaryData: !!body.summaryData,
      contextDataKeys: body.contextData ? Object.keys(body.contextData) : [],
      summaryDataKeys: body.summaryData ? Object.keys(body.summaryData) : [],
    });

    // Validate required fields
    if (!body.snapshotId || body.owner === undefined || body.owner === null) {
      return NextResponse.json(
        { error: "Missing required fields: snapshotId, owner" },
        { status: 400 }
      );
    }

    const ownerNumber =
      typeof body.owner === "number"
        ? body.owner
        : typeof body.owner === "string"
          ? Number.parseInt(body.owner, 10)
          : Number.NaN;

    if (!Number.isFinite(ownerNumber)) {
      return NextResponse.json(
        { error: "Field 'owner' must be a numeric identifier" },
        { status: 400 }
      );
    }

    // Check if snapshot already exists (idempotent)
    const existing = await prisma.habit_snapshots.findUnique({
      where: { snapshot_id: body.snapshotId },
    });

    if (existing) {
      console.log("[habit-snapshots] Snapshot already exists:", body.snapshotId);
      return NextResponse.json({ 
        message: "Snapshot already exists",
        id: existing.id 
      });
    }

    const contextData = sanitizeContextData(body.contextData, ownerNumber, body.snapshotId);
    const summaryData = sanitizeSummaryData(body.summaryData);

    const summaryTopCategories = summaryData.topCategories as unknown[] | undefined;
    if (!contextData.topCategories && Array.isArray(summaryTopCategories) && summaryTopCategories.length > 0) {
      contextData.topCategories = summaryTopCategories;
    }

    const summaryFrequentMerchants = summaryData.frequentMerchants as unknown[] | undefined;
    if (!contextData.frequentMerchants && Array.isArray(summaryFrequentMerchants) && summaryFrequentMerchants.length > 0) {
      contextData.frequentMerchants = summaryFrequentMerchants;
    }

    const summarySpendingByMedium = summaryData.spendingByMedium as unknown[] | undefined;
    if (!contextData.spendingByMedium && Array.isArray(summarySpendingByMedium) && summarySpendingByMedium.length > 0) {
      contextData.spendingByMedium = summarySpendingByMedium;
    }

    const summaryBehavior = summaryData.behaviorSummary as string | undefined;
    if (!contextData.behaviorSummary && typeof summaryBehavior === "string" && summaryBehavior.length > 0) {
      contextData.behaviorSummary = summaryBehavior;
    }

    const summaryRecommendations = summaryData.recommendations as unknown[] | undefined;
    if (!contextData.recommendations && Array.isArray(summaryRecommendations) && summaryRecommendations.length > 0) {
      contextData.recommendations = summaryRecommendations;
    }

    synchronizeBooleanField(contextData, summaryData, "isOverspending");
    synchronizeBooleanField(contextData, summaryData, "hasRecurringPayments");
    synchronizeBooleanField(contextData, summaryData, "showsImpulseBuying");
    synchronizeBooleanField(contextData, summaryData, "needsBudgetAlert");

    const contextInsights = extractContextInsights(contextData);
    const metadata = deriveSnapshotMetadata(contextData, summaryData, contextInsights);
    const explicitInsightIds = extractInsightIdsFromArray(body.insightIds);
    const resolvedInsightIds = await mergeInsightIdSources(ownerNumber, contextInsights, explicitInsightIds);

    const insightConfidence = new Map<number, number>();
    for (const insight of contextInsights) {
      if (typeof insight.insightId === "number" && Number.isFinite(insight.insightId) && typeof insight.confidence === "number") {
        insightConfidence.set(Math.trunc(insight.insightId), insight.confidence);
      }
    }

    const snapshotData: any = {
      snapshot_id: body.snapshotId,
      owner: ownerNumber,
      context_data: contextData,
      summary_data: summaryData,
      generated_at: metadata.generatedAt,
      transaction_id: metadata.transactionId,
      insights_count: metadata.insightsCount,
      snapshot_hash: metadata.snapshotHash,
      status: "published",
    };

    if (metadata.topCategories !== undefined) {
      snapshotData.top_categories = metadata.topCategories;
    }
    if (metadata.frequentMerchants !== undefined) {
      snapshotData.frequent_merchants = metadata.frequentMerchants;
    }
    if (metadata.spendingByMedium !== undefined) {
      snapshotData.spending_by_medium = metadata.spendingByMedium;
    }
    if (metadata.flags.length > 0) {
      snapshotData.flags = metadata.flags;
    }
    if (metadata.insightLabels.length > 0) {
      snapshotData.insight_labels = metadata.insightLabels;
    }

    const snapshot = await prisma.habit_snapshots.create({
      data: snapshotData,
    });

    if (resolvedInsightIds.length > 0) {
      const linkPayload = resolvedInsightIds.map((insightId) => {
        const confidence = insightConfidence.get(insightId);
        if (confidence !== undefined) {
          return {
            snapshot: snapshot.id,
            insight: insightId,
            confidence: confidence.toFixed(4),
          };
        }
        return {
          snapshot: snapshot.id,
          insight: insightId,
        };
      }) as any[];

      await prisma.habit_snapshot_insights.createMany({
        data: linkPayload,
        skipDuplicates: true,
      });
    }

    console.log("[habit-snapshots] ✅ Created snapshot:", {
      id: snapshot.id,
      snapshotId: snapshot.snapshot_id,
    });

    return NextResponse.json({ 
      message: "Snapshot created",
      id: snapshot.id 
    });

  } catch (error) {
    console.error("[habit-snapshots] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/habit-snapshots - Fetch habit snapshots for a user
 */
export async function GET(request: Request) {
  const userContext = await getUserContext(request);

  if (!userContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  let ownerFilter: number;

  if (userContext.isService) {
    const ownerParam = url.searchParams.get("owner");
    if (!ownerParam) {
      return NextResponse.json(
        { error: "Missing 'owner' query param for service requests" },
        { status: 400 }
      );
    }
    ownerFilter = Number.parseInt(ownerParam, 10);
  } else {
    ownerFilter = userContext.userId as number;
  }

  const snapshots = await prisma.habit_snapshots.findMany({
    where: {
      owner: ownerFilter,
      status: { not: "archived" },
    },
    orderBy: {
      id: "desc",
    },
    take: 50,
  });

  return NextResponse.json({ data: snapshots });
}
