import { readFile } from "node:fs/promises";

import type { LogCashTransactionPayload } from "../../tools/log-cash-transaction.js";
import { categorizeTransaction } from "../shared/categorize.js";
import type { CategorizationResult } from "../shared/categorize.js";
import { createConcurrencyLimiter } from "../shared/concurrency-limiter.js";
import { PIIMasker } from "../shared/pii-masker.js";
import {
  createDevAgentEnvironment,
  runDevPipeline,
  type DevAgentEnvironment,
  type DevPipelineOptions,
  type DevPipelineResult,
  type DevTools,
} from "./dev-agent.js";
import type {
  NormalizeTransactionOptions,
  NormalizedTransaction,
} from "./transaction-normalizer.js";
import { createSmsLog, type SmsLog, type SmsLogOptions } from "./sms-log.js";
import { extractTransactionFromSms, type DevExtraction } from "./dev-llm-parser.js";

export interface SmsExport {
  owner?: {
    name?: string;
    phone?: string;
  };
  messages: SmsMessage[];
}

export interface SmsMessage {
  sender: string;
  senderName?: string;
  message: string;
  timestamp?: string;
  date?: string;
  time?: string;
  datetime_readable?: string;
  category?: string;
  score?: string;
  is_financial?: string;
  amount?: string;
  currency?: string;
  type?: string;
  medium?: string;
  targetParty?: string;
  description?: string;
  extractedDate?: string;
}

export interface SmsIngestOptions extends NormalizeTransactionOptions {
  devEnvironment?: DevAgentEnvironment;
  devTools?: DevTools;
  onProcessed?: (result: DevPipelineResult, message: SmsMessage) => Promise<void> | void;
  smsLog?: SmsLog;
  smsLogOptions?: SmsLogOptions;
}

export interface ProcessSmsMessageOptions extends NormalizeTransactionOptions {
  devEnvironment?: DevAgentEnvironment;
  devTools?: DevTools;
  smsLog?: SmsLog;
}

export type ProcessSmsMessageOutcome =
  | {
      status: "processed";
      result: Extract<DevPipelineResult, { status: "logged" }>;
    }
  | {
      status: "suppressed";
      candidate: NormalizedTransaction;
      duplicateOf: NormalizedTransaction;
      reason: string;
    }
  | {
      status: "duplicate";
      pendingId: string;
      candidate: NormalizedTransaction;
      duplicateOf: NormalizedTransaction;
    }
  | { status: "skipped"; reason: "non-financial" | "invalid" };

export interface SmsIngestSummary {
  processed: number;
  skipped: number;
  errors: number;
  duplicates: number;
  suppressed: number;
  ownerName?: string;
  ownerPhone?: string;
}

export async function ingestSmsExport(
  filePath: string,
  options: SmsIngestOptions = {},
): Promise<SmsIngestSummary> {
  const content = await readFile(filePath, "utf8");
  const parsed = JSON.parse(content) as SmsExport;

  const summary: SmsIngestSummary = {
    processed: 0,
    skipped: 0,
    errors: 0,
    duplicates: 0,
    suppressed: 0,
  };

  if (parsed.owner?.name) {
    summary.ownerName = parsed.owner.name;
  }
  if (parsed.owner?.phone) {
    summary.ownerPhone = parsed.owner.phone;
  }

  const localEnvironment = options.devEnvironment ??
    (options.devTools ? undefined : await createDevAgentEnvironment());
  const tools = options.devTools ?? localEnvironment?.tools;
  const smsLog = options.smsLog ?? (await resolveSmsLog(options.smsLogOptions));

  if (!tools) {
    throw new Error("Dev tools unavailable for SMS ingestion");
  }

  const messages = parsed.messages ?? [];
  const concurrencyLimit = 6; // Process up to 6 messages in parallel
  const limiter = createConcurrencyLimiter(concurrencyLimit);

  console.log(`[dev-sms] Starting ingestion of ${messages.length} messages with concurrency ${concurrencyLimit}`);

  // Process messages with controlled concurrency
  const results = await Promise.all(
    messages.map((message) =>
      limiter(async () => {
        try {
          if (!isFinancial(message)) {
            return { type: "skipped" as const };
          }

          const environment = localEnvironment ?? options.devEnvironment;
          const outcome = await processSmsMessage(message, {
            ...(environment ? { devEnvironment: environment } : {}),
            devTools: tools,
            ...(options.now ? { now: options.now } : {}),
            ...(options.defaultCurrency ? { defaultCurrency: options.defaultCurrency } : {}),
            ...(smsLog ? { smsLog } : {}),
          });

          if (outcome.status === "processed") {
            if (options.onProcessed) {
              await options.onProcessed(outcome.result, message);
            }
            return { type: "processed" as const };
          } else if (outcome.status === "suppressed") {
            return { type: "suppressed" as const };
          } else if (outcome.status === "duplicate") {
            return { type: "duplicate" as const };
          } else {
            return { type: "skipped" as const };
          }
        } catch (error) {
          console.error("[dev-sms] Failed to ingest SMS", { 
            sender: PIIMasker.maskPhone(message.sender || ''),
            senderName: message.senderName,
            messagePreview: PIIMasker.maskSMS(message.message?.slice(0, 100) || ''),
            error: error instanceof Error ? error.message : String(error)
          });
          return { type: "error" as const };
        }
      })
    )
  );

  // Aggregate results
  for (const result of results) {
    switch (result.type) {
      case "processed":
        summary.processed += 1;
        break;
      case "suppressed":
        summary.suppressed += 1;
        break;
      case "duplicate":
        summary.duplicates += 1;
        break;
      case "skipped":
        summary.skipped += 1;
        break;
      case "error":
        summary.errors += 1;
        break;
    }
  }

  console.log(
    `[dev-sms] Ingestion complete: ${summary.processed} processed, ${summary.skipped} skipped, ` +
    `${summary.duplicates} duplicates, ${summary.suppressed} suppressed, ${summary.errors} errors`
  );

  return summary;
}

export async function processSmsMessage(
  message: SmsMessage,
  options: ProcessSmsMessageOptions = {},
): Promise<ProcessSmsMessageOutcome> {
  if (!isFinancial(message)) {
    return { status: "skipped", reason: "non-financial" };
  }

  const extractions = await extractTransactionFromSms(message);
  if (!extractions || extractions.length === 0) {
    return { status: "skipped", reason: "non-financial" };
  }

  let tools = options.devTools;
  let environment = options.devEnvironment;
  if (!tools) {
    if (!environment) {
      environment = await createDevAgentEnvironment();
    }
    tools = environment.tools;
  }

  if (!tools) {
    throw new Error("Dev tools unavailable for SMS processing");
  }

  // Process first extraction for backward compatibility
  // TODO: Support multiple extractions with aggregated outcome
  const extraction = extractions[0];
  if (!extraction) {
    return { status: "skipped", reason: "invalid" };
  }

  const direction: LogCashTransactionPayload["direction"] =
    extraction.type === "credit" ? "income" : "expense";

  const payload: LogCashTransactionPayload = {
    amount: extraction.amount,
    description: extraction.description,
    category_suggestion: extraction.category,
    direction,
    raw_text: message.message,
  };

  const categorization = categorizeTransaction(payload.description, payload.amount);
  if (payload.category_suggestion.length === 0) {
    payload.category_suggestion = categorization.inferredCategory;
  }

  const eventDetails = resolveEventOverrides(extraction.date_of_transaction);
  const extraHeuristics = buildHeuristics(message, extraction);
  if (typeof options.meta?.originalSmsId === "number") {
    extraHeuristics.push(`original-sms:${options.meta.originalSmsId}`);
  }
  const extraTags = buildTagsFromExtraction(extraction);

  const pipelineMeta: NonNullable<NormalizeTransactionOptions["meta"]> = {
    ...(options.meta ?? {}),
  };

  if (extraction.targetParty && extraction.targetParty.length > 0) {
    pipelineMeta.targetParty = extraction.targetParty;
  }

  if (extraction.medium && extraction.medium.length > 0) {
    pipelineMeta.medium = extraction.medium;
  }

  const pipelineOptions: DevPipelineOptions = {
    tools,
    ...(environment?.alertManager ? { alertManager: environment.alertManager } : {}),
    source: "sms-webhook",
    defaultCurrency: extraction.currency,
    extraHeuristics,
    extraTags,
    meta: pipelineMeta,
  };

  if (options.now) {
    pipelineOptions.now = options.now;
  }

  if (!pipelineOptions.defaultCurrency && options.defaultCurrency) {
    pipelineOptions.defaultCurrency = options.defaultCurrency;
  }

  if (eventDetails.eventDate) {
    pipelineOptions.eventDateOverride = eventDetails.eventDate;
  }

  if (eventDetails.eventTime !== undefined) {
    pipelineOptions.eventTimeOverride = eventDetails.eventTime;
  }

  const result = await runDevPipeline(payload, categorization, pipelineOptions);

  if (result.status === "suppressed") {
    return {
      status: "suppressed",
      candidate: result.normalized,
      duplicateOf: result.duplicateOf,
      reason: result.reason,
    };
  }

  if (result.status === "duplicate") {
    return {
      status: "duplicate",
      pendingId: result.pendingId,
      candidate: result.normalized,
      duplicateOf: result.duplicateOf,
    };
  }

  const loggedResult: Extract<DevPipelineResult, { status: "logged" }> = result;

  if (options.smsLog) {
    await options.smsLog.record(message, loggedResult);
  }

  return { status: "processed", result: loggedResult };
}

function isFinancial(message: SmsMessage): boolean {
  const explicit = message.is_financial?.toLowerCase();
  if (explicit === "true") {
    return true;
  }
  if (explicit === "false") {
    return false;
  }

  const body = message.message.toLowerCase();
  return /rs\.|inr|credited|debited|dr\.|cr\./.test(body);
}

interface EventOverrides {
  eventDate?: string;
  eventTime?: string;
}

function resolveEventOverrides(timestamp: string): EventOverrides {
  if (!timestamp) {
    return {};
  }

  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return {};
  }

  const date = new Date(parsed);
  const overrides: EventOverrides = {};
  overrides.eventDate = formatDatePart(date);

  const timePart = formatTimePart(date);
  if (timePart) {
    overrides.eventTime = timePart;
  }

  return overrides;
}

function buildHeuristics(message: SmsMessage, extraction: DevExtraction): string[] {
  const heuristics = new Set<string>();
  heuristics.add("source:sms-llm");
  heuristics.add(`medium:${extraction.medium}`);
  heuristics.add(`date_of_transaction:${extraction.date_of_transaction}`);

  if (extraction.targetParty.length > 0) {
    heuristics.add(`target:${extraction.targetParty}`);
  }

  if (message.sender) {
    heuristics.add(`sender:${message.sender}`);
  }

  if (message.senderName) {
    heuristics.add(`sender-name:${message.senderName}`);
  }

  if (message.timestamp) {
    heuristics.add(`payload-ts:${message.timestamp}`);
  }

  if (message.date) {
    heuristics.add(`payload-date:${message.date}`);
  }

  if (message.time) {
    heuristics.add(`payload-time:${message.time}`);
  }

  return Array.from(heuristics);
}

function buildTagsFromExtraction(extraction: DevExtraction): string[] {
  const tags = new Set<string>();
  tags.add("sms-ingest");
  tags.add(`medium-${extraction.medium}`);
  tags.add(`type-${extraction.type}`);
  return Array.from(tags);
}

function formatDatePart(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatTimePart(date: Date): string | undefined {
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();

  if (hours === 0 && minutes === 0 && seconds === 0) {
    return undefined;
  }

  return `${formatTwoDigits(hours)}:${formatTwoDigits(minutes)}`;
}

function formatTwoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

async function resolveSmsLog(options?: SmsLogOptions): Promise<SmsLog | undefined> {
  try {
    return await createSmsLog(options);
  } catch (error) {
    console.error("[dev-sms] Failed to initialize SMS log", error);
    return undefined;
  }
}
