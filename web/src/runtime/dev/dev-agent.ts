/**
 * Dev Agent - Data Gateway & Transaction Storage
 *
 * Persists normalized transactions through the Mill Transactions API while keeping
 * duplicate detection, alert evaluation, and downstream integration hooks. Legacy CSV
 * fallbacks have been removed; the agent now relies exclusively on the API for
 * persistence and seeding historical context.
 */

import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { devLogger } from "../shared/logger";
import { createMutex } from "../shared/mutex";
import { createTransactionAdapter } from "./transaction-adapter";
import type { LogCashTransactionPayload } from "@/tools/log-cash-transaction";
import type { CategorizationResult } from "../shared/categorize";
import {
  normalizeTransaction,
  type NormalizeTransactionOptions,
  type NormalizedTransaction,
} from "./transaction-normalizer";
import { runAnalyst } from "../param/analyst-agent";
import {
  createAlertManager,
  type TransactionAlertManager,
  type AlertRecord,
} from "./alert-manager";
import { prisma } from "@/lib/prisma";
import { callLLM } from "@/runtime/shared/llm-client";

export interface AnalystMetadata {
  transactionId: string;
  recordedAt: string;
  amount: number;
  currency: string;
  direction: NormalizedTransaction["direction"];
  category: string;
  flavor: CategorizationResult["flavor"];
  tags: string[];
  description: string;
  eventDate: string;
  eventTime?: string;
}

export interface DevTools {
  saveToDatabase(transaction: NormalizedTransaction, ownerId?: number): Promise<void>;
  sendToAnalyst(metadata: AnalystMetadata): Promise<void>;
}

export interface DevPipelineOptions extends NormalizeTransactionOptions {
  tools: DevTools;
  alertManager?: TransactionAlertManager;
}

export type DevPipelineResult =
  | {
      status: "logged";
      normalized: NormalizedTransaction;
      metadata: AnalystMetadata;
      alerts?: AlertRecord[];
    }
  | {
      status: "suppressed";
      normalized: NormalizedTransaction;
      duplicateOf: NormalizedTransaction;
      reason: string;
    }
  | {
      status: "duplicate";
      normalized: NormalizedTransaction;
      duplicateOf: NormalizedTransaction;
      pendingId: string;
    };

export interface DuplicateTransactionEvent {
  pendingId: string;
  candidate: NormalizedTransaction;
  existing: NormalizedTransaction;
}

export type DuplicateResolutionAction = "record" | "ignore";

export type DuplicateResolutionResult =
  | {
      status: "recorded";
      pendingId: string;
      candidate: NormalizedTransaction;
      existing: NormalizedTransaction;
      metadata: AnalystMetadata;
    }
  | {
      status: "ignored";
      pendingId: string;
      candidate: NormalizedTransaction;
      existing: NormalizedTransaction;
    }
  | {
      status: "not-found";
      pendingId: string;
    };

export interface PendingDuplicateSummary {
  pendingId: string;
  candidate: NormalizedTransaction;
  existing: NormalizedTransaction;
}

export interface DevAgentEnvironment {
  tools: DevTools;
  alertManager: TransactionAlertManager;
  onDuplicate(
    handler: (event: DuplicateTransactionEvent) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
  resolveDuplicate(
    pendingId: string,
    action: DuplicateResolutionAction,
  ): Promise<DuplicateResolutionResult>;
  listPendingDuplicates(): PendingDuplicateSummary[];
}

export class DuplicateTransactionError extends Error {
  constructor(
    public readonly pendingId: string,
    public readonly existing: NormalizedTransaction,
  ) {
    super("Duplicate transaction detected");
    this.name = "DuplicateTransactionError";
  }
}

export class SuppressedDuplicateError extends Error {
  constructor(
    public readonly candidate: NormalizedTransaction,
    public readonly existing: NormalizedTransaction,
    public readonly reason: string,
  ) {
    super("Duplicate transaction automatically suppressed");
    this.name = "SuppressedDuplicateError";
  }
}

// Tracking metadata stored in DB; legacy CSV headers removed.

export async function runDevPipeline(
  payload: LogCashTransactionPayload,
  categorization: CategorizationResult,
  options: DevPipelineOptions,
): Promise<DevPipelineResult> {
  const { tools, ...normalizerOptions } = options;
  const normalized = normalizeTransaction(payload, categorization, normalizerOptions);
  const metadata = createTransactionAdapter(normalized).toAnalystMetadata();

  // Extract ownerId early so downstream hooks (analyst, alerts) can be triggered
  const ownerId = (options as any)?.meta?.ownerId ? Number((options as any).meta.ownerId) : undefined;

  try {
    await tools.saveToDatabase(normalized, ownerId);
  } catch (error) {
    if (error instanceof SuppressedDuplicateError) {
      return {
        status: "suppressed",
        normalized,
        duplicateOf: error.existing,
        reason: error.reason,
      };
    }

    if (error instanceof DuplicateTransactionError) {
      return {
        status: "duplicate",
        normalized,
        duplicateOf: error.existing,
        pendingId: error.pendingId,
      };
    }

    throw error;
  }
  // Notify analyst. Prefer an in-process Param run when we have an ownerId
  try {
    // Allow DevTools to perform any custom send behavior
    await tools.sendToAnalyst(metadata);
  } catch (err) {
    devLogger.warn("tools.sendToAnalyst failed", { error: err });
  }

  if (typeof ownerId === "number") {
    try {
      // Trigger Param analyst to produce habit insights for this owner.
      // We run it asynchronously but await to ensure insights are available
      // for immediate reads in caller flows that expect fresh insights.
      await runAnalyst({ ownerId, trigger: "manual" });
    } catch (err) {
      devLogger.error("runAnalyst failed", { error: err, ownerId });
    }
  }
  let alerts: AlertRecord[] = [];

  if (options.alertManager) {
    try {
      const evaluatedAlerts = await options.alertManager.evaluateTransaction(normalized);
      alerts = evaluatedAlerts.filter(isHighImpactAlert);
      if (alerts.length > 0) {
        normalized.meta.alerts = alerts.map((record) => ({
          id: record.id,
          rule: record.rule,
          severity: record.severity,
          summary: record.summary,
        }));
      }
    } catch (alertError) {
      devLogger.error("Alert evaluation failed", { error: alertError });
    }
  }

  return {
    status: "logged",
    normalized,
    metadata,
    ...(alerts.length > 0 ? { alerts } : {}),
  };
}

function isHighImpactAlert(alert: AlertRecord): boolean {
  if (alert.severity === "high") {
    return true;
  }

  if (alert.severity === "medium" && alert.confidence >= 0.78) {
    return true;
  }

  return false;
}

export interface FileSystemDevToolOptions {
  baseDir?: string;
}

export async function createDevAgentEnvironment(
  options: FileSystemDevToolOptions = {},
): Promise<DevAgentEnvironment> {
  const baseDir = options.baseDir ?? join(process.cwd(), "data");
  // No external seed-loader: keep seeded transactions empty and rely on DB
  const seededTransactions: NormalizedTransaction[] = [];

  const knownTransactionIds = new Set<string>();

  const duplicateIndex = new Map<string, NormalizedTransaction>();
  const duplicateMutex = createMutex(); // Replace promise-based guards with mutex
  const pendingDuplicates = new Map<
    string,
    { candidate: NormalizedTransaction; existing: NormalizedTransaction }
  >();
  const duplicateHandlers = new Set<
    (event: DuplicateTransactionEvent) => Promise<void> | void
  >();

  seededTransactions.forEach((record: NormalizedTransaction) => {
    knownTransactionIds.add(record.id);
    updateDuplicateIndex(record);
  });

  const alertManager = await createAlertManager({ baseDir });

  function findDuplicate(transaction: NormalizedTransaction): NormalizedTransaction | undefined {
    const key = buildDuplicateKey(transaction);
    const existing = duplicateIndex.get(key);

    if (!existing) {
      return undefined;
    }

    if (existing.id === transaction.id) {
      return undefined;
    }

    return existing;
  }

  function updateDuplicateIndex(transaction: NormalizedTransaction): void {
    const key = buildDuplicateKey(transaction);
    duplicateIndex.set(key, transaction);
  }

  const tools: DevTools = {
    async saveToDatabase(transaction, ownerId) {
      const guardKey = buildDuplicateKey(transaction);
      
      // Use mutex for proper race-free duplicate detection
      return await duplicateMutex.runExclusive(guardKey, async () => {
        const duplicate = findDuplicate(transaction);

        if (duplicate) {
          const suppressionReason = shouldAutoSuppressDuplicate(transaction, duplicate);

          if (suppressionReason) {
            throw new SuppressedDuplicateError(transaction, duplicate, suppressionReason);
          }

          pendingDuplicates.set(transaction.id, { candidate: transaction, existing: duplicate });
          await notifyDuplicateHandlers({
            pendingId: transaction.id,
            candidate: transaction,
            existing: duplicate,
          });
          throw new DuplicateTransactionError(transaction.id, duplicate);
        }

        // Persist to database if ownerId provided
        if (typeof ownerId === "number") {
          try {
            // Map normalized transaction to DB schema conservatively
            const dbType = transaction.direction === "income" ? "credit" : "debit";
            const dateOfTx = transaction.eventTime ? new Date(`${transaction.eventDate}T${transaction.eventTime}`) : new Date(transaction.eventDate);

              await prisma.tranasctions.create({
              data: {
                id: transaction.id,
                owner: ownerId,
                amount: transaction.amount,
                description: transaction.description,
                category: transaction.category,
                type: dbType,
                status: "Active",
                date_of_transaction: dateOfTx,
                date_created: new Date(),
                date_updated: new Date(),
                  // Leave `original_sms` unset (legacy field expects numeric id)
              },
            });
          } catch (err) {
            devLogger.error("DevTools.saveToDatabase: failed to persist to DB", { error: err });
            throw err;
          }
        }

        knownTransactionIds.add(transaction.id);
        updateDuplicateIndex(transaction);
      });
    },
    async sendToAnalyst(metadata) {
      // TODO: Param agent (habit tracker) is stubbed due to schema mismatch
      // When implemented, this would analyze transaction patterns
      devLogger.warn("[dev-agent] sendToAnalyst called but Param agent is stubbed - skipping habit analysis");
      return;
    },
  };

  async function onDuplicate(
    handler: (event: DuplicateTransactionEvent) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    duplicateHandlers.add(handler);

    const stop = async () => {
      duplicateHandlers.delete(handler);
    };

    return stop;
  }

  async function notifyDuplicateHandlers(event: DuplicateTransactionEvent): Promise<void> {
    for (const handler of duplicateHandlers) {
      try {
        await handler(event);
      } catch (error) {
        devLogger.error("Duplicate handler failed", { error });
      }
    }
  }

  async function resolveDuplicate(
    pendingId: string,
    action: DuplicateResolutionAction,
  ): Promise<DuplicateResolutionResult> {
    const pending = pendingDuplicates.get(pendingId);

    if (!pending) {
      return { status: "not-found", pendingId };
    }

    pendingDuplicates.delete(pendingId);

    if (action === "ignore") {
      return {
        status: "ignored",
        pendingId,
        candidate: pending.candidate,
        existing: pending.existing,
      };
    }

    knownTransactionIds.add(pending.candidate.id);
    updateDuplicateIndex(pending.candidate);

    const metadata = createTransactionAdapter(pending.candidate).toAnalystMetadata();

    return {
      status: "recorded",
      pendingId,
      candidate: pending.candidate,
      existing: pending.existing,
      metadata,
    };
  }

  function listPendingDuplicates(): PendingDuplicateSummary[] {
    return Array.from(pendingDuplicates.entries()).map(([pendingId, entry]) => ({
      pendingId,
      candidate: entry.candidate,
      existing: entry.existing,
    }));
  }

  return {
    tools,
    alertManager,
    onDuplicate,
    resolveDuplicate,
    listPendingDuplicates,
  };
}

export async function createFileSystemDevTools(
  options: FileSystemDevToolOptions = {},
): Promise<DevTools> {
  const environment = await createDevAgentEnvironment(options);
  return environment.tools;
}

/**
 * Analyze raw SMS text and return a draft transaction object with any missing fields.
 * This does NOT write to the database.
 */
export async function analyzeRawSMS(text: string): Promise<{ status: "draft"; data: Record<string, any>; missing: string[]; confidence: "low" | "medium" | "high" } | { status: "unparseable" }> {
  const systemPrompt = `You are an assistant that extracts structured transaction data from a single SMS message. Return a JSON object or the string null. The JSON object must include keys: amount (number), currency (string), type ("credit"|"debit"), description (string), merchant (string|null), date (ISO-8601|null), category (string|null). Also include a 'confidence' field (low|medium|high) and an array 'missing' listing missing keys. If the message cannot be parsed as a financial transaction, respond with null.`;

  const userPrompt = `SMS: ${text}`;

  try {
    const result = await callLLM("agent2", { messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0.1 });
    const textOut = (result as any)?.text ?? (result as any)?.output ?? "";
    if (!textOut || typeof textOut !== "string") return { status: "unparseable" };

    let parsed: any = null;
    try {
      parsed = JSON.parse(textOut.trim());
    } catch (err) {
      const m = textOut.match(/```json\s*([\s\S]*?)```/i);
      if (m && m[1]) {
        try {
          parsed = JSON.parse(m[1].trim());
        } catch (err2) {
          return { status: "unparseable" };
        }
      } else {
        return { status: "unparseable" };
      }
    }

    if (!parsed) return { status: "unparseable" };

    const required = ["amount", "currency", "type", "description"];
    const missing: string[] = [];
    for (const k of required) {
      if (parsed[k] === undefined || parsed[k] === null || parsed[k] === "") missing.push(k);
    }

    const confidence = (parsed.confidence && ["low", "medium", "high"].includes(parsed.confidence)) ? parsed.confidence : "medium";

    const data = {
      amount: parsed.amount ?? null,
      currency: parsed.currency ?? "INR",
      type: parsed.type ?? null,
      description: parsed.description ?? text,
      merchant: parsed.merchant ?? parsed.targetParty ?? null,
      date: parsed.date ?? null,
      category: parsed.category ?? null,
      raw: text,
    };

    return { status: "draft", data, missing, confidence };
  } catch (err) {
    devLogger.error("analyzeRawSMS failed", { error: err });
    return { status: "unparseable" };
  }
}

/**
 * Commit a finalized transaction payload to the system. This runs the Dev pipeline
 * (dedupe, persistence, analyst triggering). Pass `ownerId` to associate with user.
 */
export async function commitTransaction(ownerId: number, payload: any): Promise<any> {
  try {
    const tools = await createFileSystemDevTools();
    const categorization = { flavor: "unknown", inferredCategory: payload.category ?? "Uncategorized" } as any;

    // Construct minimal LogCashTransactionPayload shape expected by runDevPipeline
    const normalizedPayload: any = {
      id: payload.id ?? randomUUID(),
      amount: payload.amount,
      description: payload.description ?? payload.raw ?? "",
      category: payload.category ?? payload.inferredCategory ?? "Uncategorized",
      direction: payload.type === "credit" ? "income" : "expense",
      eventDate: payload.date ? payload.date.slice(0, 10) : new Date().toISOString().slice(0, 10),
      eventTime: payload.date ? payload.date.slice(11, 19) : undefined,
      meta: {},
    };

    const result = await runDevPipeline(normalizedPayload, categorization, {
      tools,
      meta: { ownerId },
      alertManager: undefined,
    } as any);

    return result;
  } catch (err) {
    devLogger.error("commitTransaction failed", { error: err, ownerId, payload });
    throw err;
  }
}

/**
 * Build duplicate key using SHA-256 hash for fast comparison
 * Uses normalized transaction fields to detect duplicates
 */
function buildDuplicateKey(transaction: NormalizedTransaction): string {
  const adapter = createTransactionAdapter(transaction);
  const components = adapter.getDuplicateKeyComponents();
  
  // Concatenate components
  const keyString = [
    components.direction,
    components.amount,
    components.currency,
    components.eventDate,
    components.eventTime,
    components.description,
    components.targetParty,
  ].join("|");
  
  // Hash for fast comparison and consistent length
  return createHash("sha256").update(keyString).digest("hex");
}

function shouldAutoSuppressDuplicate(
  candidate: NormalizedTransaction,
  existing: NormalizedTransaction,
): string | undefined {
  if (candidate.currency.trim().toUpperCase() !== existing.currency.trim().toUpperCase()) {
    return undefined;
  }

  const amountDelta = Math.abs(candidate.amount - existing.amount);
  if (amountDelta > 0.005) {
    return undefined;
  }

  const candidateTarget = candidate.meta.targetParty?.trim().toLowerCase() ?? "";
  const existingTarget = existing.meta.targetParty?.trim().toLowerCase() ?? "";
  if (candidateTarget.length > 0 && existingTarget.length > 0 && candidateTarget !== existingTarget) {
    return undefined;
  }

  const candidateDescription = candidate.description.trim().toLowerCase();
  const existingDescription = existing.description.trim().toLowerCase();
  if (candidateDescription.length > 0 && existingDescription.length > 0) {
    const descriptionDistance = Math.abs(candidateDescription.length - existingDescription.length);
    if (descriptionDistance > 12 && candidateDescription !== existingDescription) {
      return undefined;
    }
  }

  const candidateTimestamp = resolveTransactionTimestamp(candidate);
  const existingTimestamp = resolveTransactionTimestamp(existing);

  if (candidateTimestamp === undefined || existingTimestamp === undefined) {
    return undefined;
  }

  const deltaMs = Math.abs(candidateTimestamp - existingTimestamp);
  const TWO_MINUTES_MS = 2 * 60 * 1000;

  if (deltaMs <= TWO_MINUTES_MS) {
    return "exact-match-within-window";
  }

  return undefined;
}

function resolveTransactionTimestamp(transaction: NormalizedTransaction): number | undefined {
  if (transaction.eventDate) {
    if (transaction.eventTime) {
      const candidate = Date.parse(`${transaction.eventDate}T${transaction.eventTime}`);
      if (!Number.isNaN(candidate)) {
        return candidate;
      }
    }

    const candidate = Date.parse(transaction.eventDate);
    if (!Number.isNaN(candidate)) {
      return candidate;
    }
  }

  const recorded = Date.parse(transaction.recordedAt);
  if (!Number.isNaN(recorded)) {
    return recorded;
  }

  return undefined;
}

async function loadSeedTransactionsFromApi(): Promise<NormalizedTransaction[]> {
  // Seed loading not needed - transactions are already in database
  return [];
}

/**
 * Read transactions for an owner from the canonical DB. Dev exposes this so
 * Mill and other callers use a single data-access path.
 */
export async function fetchStoredTransactions(ownerId: number, limit = 50): Promise<any[]> {
  try {
      return await prisma.tranasctions.findMany({
      where: { owner: ownerId, status: "Active" },
      orderBy: { date_of_transaction: "desc" },
      take: limit,
    });
  } catch (err) {
    devLogger.error("fetchStoredTransactions failed", { ownerId, error: err });
    return [];
  }
}

export async function fetchCoachBriefings(ownerId: number, limit = 5): Promise<any[]> {
  try {
    return await prisma.coach_briefings.findMany({
      where: { owner: ownerId },
      orderBy: { date_created: "desc" },
      take: limit,
    });
  } catch (err) {
    devLogger.error("fetchCoachBriefings failed", { ownerId, error: err });
    return [];
  }
}

export async function computeSpendingSummary(ownerId: number) {
  try {
    const transactions = await fetchStoredTransactions(ownerId, 1000);
    let totalIncome = 0;
    let totalExpense = 0;
    const categoryMap = new Map<string, number>();

    for (const t of transactions) {
      const amt = Number(t.amount || 0);
      if (t.type === "credit") totalIncome += amt;
      else if (t.type === "debit") {
        totalExpense += amt;
        const cat = t.category || "Uncategorized";
        categoryMap.set(cat, (categoryMap.get(cat) || 0) + amt);
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
  } catch (err) {
    devLogger.error("computeSpendingSummary failed", { ownerId, error: err });
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

/**
 * Fetch persisted habit insights for an owner. Mill/clients should call this
 * instead of reaching into `prisma` directly so reads are centralized.
 */
export async function fetchHabitInsights(ownerId: number, limit = 5) {
  try {
    // Use a raw SQL query to avoid Prisma trying to select DB columns
    // that may be absent in the live database (e.g. `updated_at`).
    const rows = await prisma.$queryRaw`
      SELECT id, habit_id, owner, habit_label, evidence, counsel, full_text, metrics, recorded_at, superseded, previous_habit_id
      FROM habit_insights
      WHERE owner = ${ownerId} AND coalesce(superseded, false) = false
      ORDER BY recorded_at DESC
      LIMIT ${limit}
    `;

    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    devLogger.error("fetchHabitInsights failed", { ownerId, error: err });
    return [];
  }
}

/**
 * Persist a synthetic habit insight on behalf of callers (Mill fallback).
 * Keeps persistence centralized in Dev so Mill can remain a presentation layer.
 */
export async function persistSyntheticHabitInsight(ownerId: number, insight: { habitLabel: string; evidence: string; counsel: string; fullText?: string; }) {
  try {
    const habitId = randomUUID();
    // Insert via raw SQL to avoid Prisma attempting to set/read missing
    // `updated_at` or other columns present in the generated client but
    // absent from the live database.
    const fullText = insight.fullText ?? `${insight.evidence}. Suggested: ${insight.counsel}`;
    const inserted: any = await prisma.$queryRaw`
      INSERT INTO habit_insights (habit_id, owner, habit_label, evidence, counsel, full_text, recorded_at, superseded, previous_habit_id)
      VALUES (${habitId}, ${ownerId}, ${insight.habitLabel}, ${insight.evidence}, ${insight.counsel}, ${fullText}, now(), false, null)
      RETURNING id, habit_id, owner, habit_label, evidence, counsel, full_text, metrics, recorded_at, superseded, previous_habit_id
    `;

    // Some Prisma variants return the row as first element or as the value itself
    const row = Array.isArray(inserted) ? inserted[0] : inserted;

    return {
      habitId,
      habitLabel: insight.habitLabel,
      evidence: insight.evidence,
      counsel: insight.counsel,
      fullText,
      persisted: row ?? null,
    };
  } catch (err) {
    devLogger.error("persistSyntheticHabitInsight failed", { ownerId, error: err });
    return null;
  }
}

/**
 * Create a coach briefing record. Mill should call this helper instead of
 * using `prisma` directly so all writes are routed through Dev.
 */
export async function createCoachBriefing(ownerId: number, briefing: { headline?: string; counsel?: string; evidence?: string; insight_hash?: string }) {
  try {
    const record = await prisma.coach_briefings.create({
      data: {
        id: randomUUID(),
        owner: ownerId,
        headline: briefing.headline || "Coach Advice",
        counsel: briefing.counsel || "",
        evidence: briefing.evidence || "",
        status: "Active",
        date_created: new Date(),
        insight_hash: briefing.insight_hash || randomUUID(),
      },
    });

    return record;
  } catch (err) {
    devLogger.error("createCoachBriefing failed", { ownerId, error: err });
    throw err;
  }
}
