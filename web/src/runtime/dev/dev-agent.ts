/**
 * Dev Agent - Data Gateway & Transaction Storage
 *
 * Persists normalized transactions through the Mill Transactions API while keeping
 * duplicate detection, alert evaluation, and downstream integration hooks. Legacy CSV
 * fallbacks have been removed; the agent now relies exclusively on the API for
 * persistence and seeding historical context.
 */

import { join } from "node:path";
import { createHash } from "node:crypto";

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
import {
  createAlertManager,
  type TransactionAlertManager,
  type AlertRecord,
} from "./alert-manager";

export interface AnalystMetadata {
  transactionId: string;
  recordedAt: string;
  amount: number;
  currency: string;
  direction: LogCashTransactionPayload["direction"];
  category: string;
  flavor: CategorizationResult["flavor"];
  tags: string[];
  description: string;
  eventDate: string;
  eventTime?: string;
}

export interface DevTools {
  saveToDatabase(transaction: NormalizedTransaction): Promise<void>;
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

  try {
    await tools.saveToDatabase(normalized);
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

  await tools.sendToAnalyst(metadata);
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
  const seededTransactions = await loadSeedTransactionsFromApi();

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
    async saveToDatabase(transaction) {
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
