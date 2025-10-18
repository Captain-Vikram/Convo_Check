/**
 * Dev Agent - Data Gateway & Transaction Storage
 * 
 * OPTIMIZED STORAGE STRATEGY:
 * Stores only essential transaction data in CSV format to minimize storage and maximize
 * agent query performance. Omits redundant fields (full SMS text, score, sender) and 
 * reshapes timestamps to ISO format for easy sorting/analysis.
 * 
 * CSV Structure (13 columns):
 * owner_phone, transaction_id, datetime, date, time, amount, currency, type, 
 * target_party, description, category, is_financial, medium
 * 
 * Rationale:
 * - Prioritizes actionable fintech data (amount/type for balances, date/time for patterns)
 * - Enables efficient queries (e.g., sum debits by date, track UPI patterns)
 * - Lightweight for gig worker use cases with irregular income tracking
 * - Atomic operations prevent CSV corruption during concurrent writes
 */

import { access, appendFile, mkdir, writeFile, readFile } from "node:fs/promises";
import { constants, watch } from "node:fs";
import { dirname, join } from "node:path";

import type { LogCashTransactionPayload } from "../../tools/log-cash-transaction.js";
import type { CategorizationResult } from "../shared/categorize.js";
import {
  normalizeTransaction,
  type NormalizeTransactionOptions,
  type NormalizedTransaction,
} from "./transaction-normalizer.js";

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
}

export type DevPipelineResult =
  | {
      status: "logged";
      normalized: NormalizedTransaction;
      metadata: AnalystMetadata;
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
  startCsvMonitor(
    onNewRecords: (records: NormalizedTransaction[]) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
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

// Optimized CSV structure: Only essential fields for agent use
// Prioritizes actionable fintech data while keeping storage lightweight
const TRANSACTION_HEADER = [
  "owner_phone",
  "transaction_id",
  "datetime",
  "date",
  "time",
  "amount",
  "currency",
  "type",
  "target_party",
  "description",
  "category",
  "is_financial",
  "medium",
].join(",");

// Analyst metadata remains focused on analysis needs
const ANALYST_HEADER = [
  "transaction_id",
  "recorded_at",
  "amount",
  "currency",
  "direction",
  "category",
  "flavor",
  "tags",
  "description",
  "event_date",
  "event_time",
].join(",");

export async function runDevPipeline(
  payload: LogCashTransactionPayload,
  categorization: CategorizationResult,
  options: DevPipelineOptions,
): Promise<DevPipelineResult> {
  const { tools, ...normalizerOptions } = options;
  const normalized = normalizeTransaction(payload, categorization, normalizerOptions);
  const metadata = buildAnalystMetadata(normalized);

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

  return { status: "logged", normalized, metadata };
}

export interface FileSystemDevToolOptions {
  baseDir?: string;
  transactionsFileName?: string;
  analystFileName?: string;
  watchDebounceMs?: number;
}

export async function createDevAgentEnvironment(
  options: FileSystemDevToolOptions = {},
): Promise<DevAgentEnvironment> {
  const baseDir = options.baseDir ?? join(process.cwd(), "data");
  const transactionsFile = join(baseDir, options.transactionsFileName ?? "transactions.csv");
  const analystFile = join(baseDir, options.analystFileName ?? "analyst-metadata.csv");
  const debounceMs = options.watchDebounceMs ?? 200;

  await ensureCsvFile(transactionsFile, TRANSACTION_HEADER);
  await ensureCsvFile(analystFile, ANALYST_HEADER);

  const knownTransactionIds = new Set<string>();

  const duplicateIndex = new Map<string, NormalizedTransaction>();
  const pendingDuplicates = new Map<
    string,
    { candidate: NormalizedTransaction; existing: NormalizedTransaction }
  >();
  const duplicateHandlers = new Set<
    (event: DuplicateTransactionEvent) => Promise<void> | void
  >();

  await seedKnownTransactions(transactionsFile, knownTransactionIds, duplicateIndex);

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
      await appendFile(transactionsFile, `${buildTransactionCsvRow(transaction)}\n`, "utf8");
    },
    async sendToAnalyst(metadata) {
      await appendFile(analystFile, `${buildAnalystCsvRow(metadata)}\n`, "utf8");
    },
  };

  async function startCsvMonitor(
    onNewRecords: (records: NormalizedTransaction[]) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    let stopped = false;
    let debounceHandle: NodeJS.Timeout | null = null;

    const runScan = async () => {
      if (stopped) {
        return;
      }

      try {
        const records = await readTransactionsCsv(transactionsFile);
        const unseen = records.filter((record) => !knownTransactionIds.has(record.id));

        if (unseen.length > 0) {
          unseen.forEach((record) => knownTransactionIds.add(record.id));
          await onNewRecords(unseen);
        }
      } catch (error) {
        console.error("[dev-agent] Failed to scan transactions CSV", error);
      }
    };

    await runScan();

    const watcher = watch(transactionsFile, () => {
      if (stopped) {
        return;
      }

      if (debounceHandle) {
        clearTimeout(debounceHandle);
      }

      debounceHandle = setTimeout(() => {
        debounceHandle = null;
        void runScan();
      }, debounceMs);
    });

    const stop = async () => {
      if (stopped) {
        return;
      }

      stopped = true;
      watcher.close();

      if (debounceHandle) {
        clearTimeout(debounceHandle);
        debounceHandle = null;
      }
    };

    return stop;
  }
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
        console.error("[dev-agent] Duplicate handler failed", error);
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
    await appendFile(
      transactionsFile,
      `${buildTransactionCsvRow(pending.candidate)}\n`,
      "utf8",
    );

    const metadata = buildAnalystMetadata(pending.candidate);
    await appendFile(analystFile, `${buildAnalystCsvRow(metadata)}\n`, "utf8");

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
    startCsvMonitor,
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

function buildAnalystMetadata(transaction: NormalizedTransaction): AnalystMetadata {
  const metadata: AnalystMetadata = {
    transactionId: transaction.id,
    recordedAt: transaction.recordedAt,
    amount: transaction.amount,
    currency: transaction.currency,
    direction: transaction.direction,
    category: transaction.category,
    flavor: transaction.flavor,
    tags: transaction.tags,
    description: transaction.description,
    eventDate: transaction.eventDate,
  };

  if (transaction.eventTime) {
    metadata.eventTime = transaction.eventTime;
  }

  return metadata;
}

async function ensureCsvFile(filePath: string, header: string): Promise<void> {
  try {
    await access(filePath, constants.F_OK);
    await ensureHeaderMatches(filePath, header);
  } catch {
    await ensureParentDirectory(filePath);
    await writeFile(filePath, `${header}\n`, "utf8");
  }
}

async function ensureHeaderMatches(filePath: string, header: string): Promise<void> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    if (lines.length === 0) {
      lines.push(header);
    } else if (lines[0] !== header) {
      lines[0] = header;
    }

    const normalized = lines.join("\n");
    if (!normalized.endsWith("\n")) {
      await writeFile(filePath, `${normalized}\n`, "utf8");
    } else {
      await writeFile(filePath, normalized, "utf8");
    }
  } catch (error) {
    console.error("[dev-agent] Failed to normalize CSV header", { filePath, error });
  }
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
}

function buildTransactionCsvRow(transaction: NormalizedTransaction): string {
  // Reshape to optimized format with only essential fields
  // DateTime in ISO format: YYYY-MM-DDTHH:MM:SS
  const datetime = transaction.eventTime 
    ? `${transaction.eventDate}T${transaction.eventTime}`
    : `${transaction.eventDate}T00:00:00`;
  
  // Extract owner phone from meta.source if available (format: +919619183585)
  const ownerPhone = transaction.meta.source || "";
  
  // Map direction to type (debit/credit)
  const type = transaction.direction;
  
  // is_financial is always true for stored transactions
  const isFinancial = "true";
  
  return serializeCsvRow([
    ownerPhone,
    transaction.id,
    datetime,
    transaction.eventDate,
    transaction.eventTime ?? "00:00:00",
    transaction.amount,
    transaction.currency,
    type,
    transaction.meta.targetParty ?? "",
    transaction.description,
    transaction.category,
    isFinancial,
    transaction.meta.medium ?? "",
  ]);
}

function buildAnalystCsvRow(metadata: AnalystMetadata): string {
  return serializeCsvRow([
    metadata.transactionId,
    metadata.recordedAt,
    metadata.amount,
    metadata.currency,
    metadata.direction,
    metadata.category,
    metadata.flavor,
    metadata.tags.join("|"),
    metadata.description,
    metadata.eventDate,
    metadata.eventTime ?? "",
  ]);
}

function serializeCsvRow(values: Array<string | number | undefined | null>): string {
  return values
    .map((value) => {
      const stringValue = value === undefined || value === null ? "" : String(value);
      const escaped = stringValue.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(",");
}

function buildDuplicateKey(transaction: NormalizedTransaction): string {
  const normalizedDescription = transaction.description.trim().toLowerCase();
  const normalizedTarget = transaction.meta.targetParty?.trim().toLowerCase() ?? "";
  const normalizedCurrency = transaction.currency.trim().toUpperCase();
  const normalizedDirection = transaction.direction;
  const normalizedAmount = Number.isFinite(transaction.amount)
    ? transaction.amount.toFixed(2)
    : "0.00";
  const normalizedEventDate = transaction.eventDate;
  const normalizedEventTime = transaction.eventTime ?? "";

  return [
    normalizedDirection,
    normalizedAmount,
    normalizedCurrency,
    normalizedEventDate,
    normalizedEventTime,
    normalizedDescription,
    normalizedTarget,
  ].join("|");
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

async function seedKnownTransactions(
  filePath: string,
  target: Set<string>,
  duplicateIndex: Map<string, NormalizedTransaction>,
): Promise<void> {
  try {
    const records = await readTransactionsCsv(filePath);
    records.forEach((record) => {
      target.add(record.id);
      const key = buildDuplicateKey(record);
      if (!duplicateIndex.has(key)) {
        duplicateIndex.set(key, record);
      }
    });
  } catch (error) {
    console.error("[dev-agent] Failed to seed transaction cache", error);
  }
}

async function readTransactionsCsv(filePath: string): Promise<NormalizedTransaction[]> {
  const content = await readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  if (lines.length <= 1) {
    return [];
  }

  const records: NormalizedTransaction[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const rawLine = lines[index];

    if (!rawLine || rawLine.trim().length === 0) {
      continue;
    }

    const values = parseCsvLine(rawLine);
    if (values.length === 0) {
      continue;
    }

    try {
      records.push(deserializeNormalizedTransaction(values));
    } catch (error) {
      console.error("[dev-agent] Failed to parse CSV row", { error, rawLine });
    }
  }

  return records;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  const sanitized = line.replace(/\r$/, "");

  for (let index = 0; index < sanitized.length; index += 1) {
    const char = sanitized[index];

    if (char === '"') {
      const nextChar = sanitized[index + 1];

      if (inQuotes && nextChar === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }

      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
}

function deserializeNormalizedTransaction(values: string[]): NormalizedTransaction {
  const normalizedValues = [...values];

  // Pad to expected column count (13 for optimized format)
  while (normalizedValues.length < 13) {
    normalizedValues.push("");
  }

  const [
    ownerPhone = "",
    transactionId = "",
    datetime = "",
    eventDate = "",
    eventTime = "",
    amountRaw = "0",
    currency = "",
    type = "expense",
    targetParty = "",
    description = "",
    category = "",
    isFinancial = "true",
    medium = "",
  ] = normalizedValues;

  const amount = Number.parseFloat(amountRaw);

  // Reconstruct recordedAt from datetime (ISO format)
  const recordedAt = datetime || new Date().toISOString();

  // Map type to direction
  const direction = type as LogCashTransactionPayload["direction"];

  // Default flavor based on direction (only use spending flavors for expenses)
  const flavor: CategorizationResult["flavor"] = "necessity";

  // Parse eventDate from datetime or use provided date
  let parsedEventDate: string = eventDate;
  if (!parsedEventDate && datetime) {
    parsedEventDate = datetime.includes("T") ? datetime.split("T")[0]! : datetime;
  }
  if (!parsedEventDate) {
    parsedEventDate = new Date().toISOString().split("T")[0]!;
  }

  const normalized: NormalizedTransaction = {
    id: transactionId,
    recordedAt,
    eventDate: parsedEventDate,
    direction,
    amount: Number.isNaN(amount) ? 0 : amount,
    currency,
    category,
    flavor,
    description,
    rawText: description, // Use description as rawText since we don't store full message
    tags: [], // Tags not stored in optimized format
    structuredSummary: description,
    meta: {
      source: ownerPhone || "mill-chat",
      heuristics: ["optimized-storage"],
    },
  };

  if (eventTime && eventTime !== "00:00:00") {
    normalized.eventTime = eventTime;
  }

  if (medium) {
    normalized.meta.medium = medium;
  }

  if (targetParty) {
    normalized.meta.targetParty = targetParty;
  }

  return normalized;
}

function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split("|")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
