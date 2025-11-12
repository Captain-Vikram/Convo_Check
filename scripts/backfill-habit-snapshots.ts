import "dotenv/config";
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "pg";

const SNAPSHOT_DIR = join(process.cwd(), "data", "habit-snapshots");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://user:password@host:5432/postgres";

type SnapshotFile =
  | { id: string; variant: "insights"; insights: HabitInsightBackup[] }
  | { id: string; variant: "snapshot"; snapshot: SnapshotBackupFull };

async function loadSnapshotFiles(): Promise<SnapshotFile[]> {
  const entries = await fs.readdir(SNAPSHOT_DIR);
  const results: SnapshotFile[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const snapshotId = basename(entry, ".json");
    const fullPath = join(SNAPSHOT_DIR, entry);
    const content = await fs.readFile(fullPath, "utf8");
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        results.push({ id: snapshotId, variant: "insights", insights: parsed as HabitInsightBackup[] });
      } else if (parsed && typeof parsed === "object") {
        results.push({ id: snapshotId, variant: "snapshot", snapshot: parsed as SnapshotBackupFull });
      }
    } catch (error) {
      console.warn(`[backfill] Failed to parse ${entry}:`, error);
    }
  }

  return results;
}

interface HabitInsightBackup {
  habitLabel?: string;
  evidence?: string;
  counsel?: string;
  fullText?: string;
  habitId?: string;
  insightId?: number;
  confidence?: number;
  recordedAt?: string;
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

interface SnapshotBackupFull {
  snapshotId?: string;
  createdAt?: string;
  transactionId?: string;
  ownerPhone?: string;
  contextTransactions?: Array<Record<string, unknown>>;
  contextHabits?: Array<Record<string, unknown>>;
  totalDebits?: number;
  totalCredits?: number;
  netBalance?: number;
  transactionCount?: number;
  topCategories?: Array<Record<string, unknown>>;
  frequentMerchants?: Array<Record<string, unknown>>;
  spendingByMedium?: Array<Record<string, unknown>>;
  averageTransactionSize?: number;
  largestTransaction?: number;
  smallestTransaction?: number;
  mostActiveTime?: string;
  mostActiveDay?: string;
  isOverspending?: boolean;
  hasRecurringPayments?: boolean;
  showsImpulseBuying?: boolean;
  needsBudgetAlert?: boolean;
  behaviorSummary?: string;
  recommendations?: string[];
  insights?: HabitInsightBackup[];
}

interface NormalizedSnapshotData {
  context: Record<string, unknown>;
  summary: Record<string, unknown>;
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

function sanitizeBackupInsight(entry: HabitInsightBackup): SanitizedSnapshotInsight {
  const habitLabel = typeof entry.habitLabel === "string" ? entry.habitLabel.trim() : "";
  const sanitized: SanitizedSnapshotInsight = { habitLabel };

  if (typeof entry.evidence === "string") {
    sanitized.evidence = entry.evidence.trim();
  }
  if (typeof entry.counsel === "string") {
    sanitized.counsel = entry.counsel.trim();
  }
  if (typeof entry.fullText === "string") {
    sanitized.fullText = entry.fullText.trim();
  }
  if (typeof entry.habitId === "string" && entry.habitId.trim().length > 0) {
    sanitized.habitId = entry.habitId.trim();
  }
  if (typeof entry.insightId === "number" && Number.isFinite(entry.insightId)) {
    sanitized.insightId = Math.trunc(entry.insightId);
  }
  if (typeof entry.confidence === "number" && Number.isFinite(entry.confidence)) {
    sanitized.confidence = entry.confidence;
  }
  if (typeof entry.recordedAt === "string" && entry.recordedAt.trim().length > 0) {
    sanitized.recordedAt = entry.recordedAt.trim();
  }

  return sanitized;
}

function normalizeSnapshotBackup(snapshot: SnapshotBackupFull): NormalizedSnapshotData {
  const context: Record<string, unknown> = {};
  const summary: Record<string, unknown> = {};

  const generatedAt = coerceString(snapshot.createdAt);
  context.generatedAt = generatedAt ? new Date(generatedAt).toISOString() : new Date().toISOString();

  const transactionId = coerceString(snapshot.transactionId);
  if (transactionId) {
    context.transactionId = transactionId;
  }

  const ownerPhone = coerceString(snapshot.ownerPhone);
  if (ownerPhone) {
    context.ownerPhone = ownerPhone;
  }

  const transactions = coerceArray(snapshot.contextTransactions);
  if (transactions && transactions.length > 0) {
    context.transactions = transactions;
  }

  const habits = coerceArray(snapshot.contextHabits);
  if (habits && habits.length > 0) {
    context.habits = habits;
  }

  const topCategories = coerceArray(snapshot.topCategories);
  if (topCategories && topCategories.length > 0) {
    context.topCategories = topCategories;
    summary.topCategories = topCategories;
  }

  const frequentMerchants = coerceArray(snapshot.frequentMerchants);
  if (frequentMerchants && frequentMerchants.length > 0) {
    context.frequentMerchants = frequentMerchants;
    summary.frequentMerchants = frequentMerchants;
  }

  const spendingByMedium = coerceArray(snapshot.spendingByMedium);
  if (spendingByMedium && spendingByMedium.length > 0) {
    context.spendingByMedium = spendingByMedium;
    summary.spendingByMedium = spendingByMedium;
  }

  const averageTransactionSize = coerceNumber(snapshot.averageTransactionSize);
  if (averageTransactionSize !== undefined) {
    summary.averageTransactionSize = averageTransactionSize;
  }

  const largestTransaction = coerceNumber(snapshot.largestTransaction);
  if (largestTransaction !== undefined) {
    summary.largestTransaction = largestTransaction;
  }

  const smallestTransaction = coerceNumber(snapshot.smallestTransaction);
  if (smallestTransaction !== undefined) {
    summary.smallestTransaction = smallestTransaction;
  }

  const totalDebits = coerceNumber(snapshot.totalDebits);
  if (totalDebits !== undefined) {
    summary.totalDebits = totalDebits;
  }

  const totalCredits = coerceNumber(snapshot.totalCredits);
  if (totalCredits !== undefined) {
    summary.totalCredits = totalCredits;
  }

  const netBalance = coerceNumber(snapshot.netBalance);
  if (netBalance !== undefined) {
    summary.netBalance = netBalance;
  }

  const transactionCount = coerceNumber(snapshot.transactionCount);
  if (transactionCount !== undefined) {
    summary.transactionCount = transactionCount;
  }

  const mostActiveTime = coerceString(snapshot.mostActiveTime);
  if (mostActiveTime) {
    context.mostActiveTime = mostActiveTime;
    summary.mostActiveTime = mostActiveTime;
  }

  const mostActiveDay = coerceString(snapshot.mostActiveDay);
  if (mostActiveDay) {
    context.mostActiveDay = mostActiveDay;
    summary.mostActiveDay = mostActiveDay;
  }

  const behaviorSummary = coerceString(snapshot.behaviorSummary);
  if (behaviorSummary) {
    context.behaviorSummary = behaviorSummary;
    summary.behaviorSummary = behaviorSummary;
  }

  const recommendations = coerceArray(snapshot.recommendations);
  if (recommendations && recommendations.length > 0) {
    context.recommendations = recommendations;
    summary.recommendations = recommendations;
  }

  const flags: Array<[keyof SnapshotBackupFull, string]> = [
    ["isOverspending", "isOverspending"],
    ["hasRecurringPayments", "hasRecurringPayments"],
    ["showsImpulseBuying", "showsImpulseBuying"],
    ["needsBudgetAlert", "needsBudgetAlert"],
  ];

  for (const [sourceKey, targetKey] of flags) {
    const value = coerceBoolean(snapshot[sourceKey]);
    if (value !== undefined) {
      context[targetKey] = value;
      summary[targetKey] = value;
    }
  }

  const sanitizedInsights = Array.isArray(snapshot.insights)
    ? snapshot.insights.map(sanitizeBackupInsight).filter((entry) => entry.habitLabel.length > 0)
    : [];

  if (sanitizedInsights.length > 0) {
    context.insights = sanitizedInsights;
    summary.insightsCount = sanitizedInsights.length;
    summary.insightLabels = sanitizedInsights.map((entry) => entry.habitLabel);
  }

  return { context, summary };
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : null))
    .filter((entry): entry is string => !!entry);
}

function sanitizeExistingInsights(value: unknown): SanitizedSnapshotInsight[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => sanitizeBackupInsight(entry as HabitInsightBackup))
    .filter((insight) => insight.habitLabel.length > 0);
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

function extractBooleanFlags(context: Record<string, unknown>, summary: Record<string, unknown>): string[] {
  const flagKeys = ["isOverspending", "hasRecurringPayments", "showsImpulseBuying", "needsBudgetAlert"];
  const combined = new Set<string>(ensureStringArray(context.flags).concat(ensureStringArray(summary.flags)));

  for (const key of flagKeys) {
    if (context[key] === true || summary[key] === true) {
      combined.add(key);
    }
  }

  return Array.from(combined);
}

function deriveSnapshotMetadata(
  context: Record<string, unknown>,
  summary: Record<string, unknown>,
  insights: SanitizedSnapshotInsight[],
): SnapshotMetadata {
  const generatedAt = parseIsoDate(context.generatedAt) ?? parseIsoDate(summary.generatedAt) ?? new Date();
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

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") {
      return true;
    }
    if (value.toLowerCase() === "false") {
      return false;
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

function coerceArray<T>(value: unknown): T[] | undefined {
  if (Array.isArray(value)) {
    return value as T[];
  }
  return undefined;
}

async function run(): Promise<void> {
  const snapshotFiles = await loadSnapshotFiles();
  if (snapshotFiles.length === 0) {
    console.log("[backfill] No snapshot backup files found.");
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    let updatedCount = 0;

    for (const file of snapshotFiles) {
      const { rows } = await client.query(
        "SELECT id, owner, context_data, summary_data FROM habit_snapshots WHERE snapshot_id = $1",
        [file.id],
      );

      if (rows.length === 0) {
        console.warn(`[backfill] No database row for snapshot ${file.id}`);
        continue;
      }

      const row = rows[0];
      const contextData = row.context_data;
      const summaryData = row.summary_data;

      const baseContext = contextData && typeof contextData === "object" ? { ...contextData } : {};
      const baseSummary = summaryData && typeof summaryData === "object" ? { ...summaryData } : {};

      let newContext: Record<string, unknown> | null = null;
      let newSummary: Record<string, unknown> | null = null;

      if (file.variant === "insights") {
        const sanitizedInsights = file.insights.map(sanitizeBackupInsight).filter((entry) => entry.habitLabel.length > 0);

        newContext = {
          ...baseContext,
          insights: sanitizedInsights,
          generatedAt: new Date().toISOString(),
          generatedFromBackup: true,
        };

        newSummary = {
          ...baseSummary,
          insightsCount: sanitizedInsights.length,
          insightLabels: sanitizedInsights.map((entry) => entry.habitLabel),
        };
      } else {
        const normalized = normalizeSnapshotBackup(file.snapshot);

        newContext = {
          ...baseContext,
          ...normalized.context,
          generatedFromBackup: true,
        };

        newSummary = {
          ...baseSummary,
          ...normalized.summary,
        };
      }

      if (!newContext || !newSummary) {
        continue;
      }

      if (!newContext.owner) {
        newContext.owner = row.owner;
      }
      if (!newContext.snapshotId) {
        newContext.snapshotId = file.id;
      }

      const contextInsights = sanitizeExistingInsights((newContext as Record<string, unknown>).insights);
      if (contextInsights.length > 0) {
        newContext.insights = contextInsights;
        if (!newSummary.insightsCount) {
          newSummary.insightsCount = contextInsights.length;
        }
        if (!Array.isArray(newSummary.insightLabels) || ensureStringArray(newSummary.insightLabels).length === 0) {
          newSummary.insightLabels = contextInsights.map((entry) => entry.habitLabel);
        }
      }

      if (!newContext.topCategories && Array.isArray(newSummary.topCategories)) {
        newContext.topCategories = newSummary.topCategories;
      }
      if (!newContext.frequentMerchants && Array.isArray(newSummary.frequentMerchants)) {
        newContext.frequentMerchants = newSummary.frequentMerchants;
      }
      if (!newContext.spendingByMedium && Array.isArray(newSummary.spendingByMedium)) {
        newContext.spendingByMedium = newSummary.spendingByMedium;
      }

      const metadata = deriveSnapshotMetadata(newContext, newSummary, contextInsights);

      await client.query(
        `UPDATE habit_snapshots
         SET context_data = $1::jsonb,
             summary_data = $2::jsonb,
             generated_at = $3,
             transaction_id = $4,
             top_categories = $5::jsonb,
             frequent_merchants = $6::jsonb,
             spending_by_medium = $7::jsonb,
             flags = $8::jsonb,
             insights_count = $9,
             insight_labels = $10::jsonb,
             snapshot_hash = $11,
             date_updated = NOW()
         WHERE snapshot_id = $12`,
        [
          JSON.stringify(newContext),
          JSON.stringify(newSummary),
          metadata.generatedAt.toISOString(),
          metadata.transactionId,
          metadata.topCategories ? JSON.stringify(metadata.topCategories) : null,
          metadata.frequentMerchants ? JSON.stringify(metadata.frequentMerchants) : null,
          metadata.spendingByMedium ? JSON.stringify(metadata.spendingByMedium) : null,
          metadata.flags.length > 0 ? JSON.stringify(metadata.flags) : null,
          metadata.insightsCount,
          metadata.insightLabels.length > 0 ? JSON.stringify(metadata.insightLabels) : null,
          metadata.snapshotHash,
          file.id,
        ],
      );

      if (contextInsights.length > 0) {
        const resolvedInsightIds = new Set<number>();

        for (const insight of contextInsights) {
          if (typeof insight.insightId === "number" && Number.isFinite(insight.insightId)) {
            resolvedInsightIds.add(Math.trunc(insight.insightId));
            continue;
          }

          const { rows: matchedByLabel } = await client.query(
            `SELECT id
             FROM habit_insights
             WHERE owner = $1 AND habit_label = $2
             ORDER BY recorded_at DESC
             LIMIT 1`,
            [row.owner, insight.habitLabel],
          );

          if (matchedByLabel.length > 0) {
            resolvedInsightIds.add(matchedByLabel[0].id);
          }
        }

        for (const insightId of resolvedInsightIds) {
          await client.query(
            `INSERT INTO habit_snapshot_insights (snapshot, insight, created_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT DO NOTHING`,
            [row.id, insightId],
          );
        }
      }

      updatedCount += 1;
      console.log(`[backfill] Updated snapshot ${file.id}`);
    }

    console.log(`\n[backfill] Completed. Updated ${updatedCount} snapshot records.`);
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("[backfill] Failed:", error);
  process.exit(1);
});
