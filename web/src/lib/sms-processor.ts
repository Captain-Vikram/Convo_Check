import { createDevAgentEnvironment, runDevPipeline } from "@/runtime/dev/dev-agent";
import { categorizeTransaction } from "@/runtime/shared/categorize";
import { extractWithRegex, extractBatchWithRegex, type DevExtraction } from "@/runtime/dev/sms-regex-extractor";
// TEMP: sms-log.ts deleted - state is now in database
// import { createSmsLog, type SmsLog } from "../../../src/runtime/dev/sms-log";
import type { Prisma } from "../../../data/generated/prisma";

import { prisma } from "@/lib/prisma";

console.log("[sms-processor] Module initialized at", new Date().toISOString());

interface SmsProcessingJob {
  smsMessageId: number;
  userId: number;
  sender: string;
  senderName: string;
  message: string;
  timestampIso: string;
  datePart: string;
  timePart: string;
  isFinancialFlag?: string | null;
}

interface SmsMessage {
  sender: string;
  senderName?: string;
  message: string;
  timestamp?: string;
  date?: string;
  time?: string;
  is_financial?: string;
}

type ProcessSmsMessageOutcome =
  | { status: "processed"; result: any }
  | { status: "duplicate"; pendingId: number; duplicateOf: any; candidate?: any }
  | { status: "suppressed"; reason: string; duplicateOf: any; candidate?: any }
  | { status: "skipped"; reason: string };

type DevEnvironment = Awaited<ReturnType<typeof createDevAgentEnvironment>>;

let environmentPromise: Promise<DevEnvironment> | null = null;
// let smsLogPromise: Promise<SmsLog | undefined> | null = null;

const queue: SmsProcessingJob[] = [];
let isProcessingQueue = false;
let resumeInitialization: Promise<void> | null = null;

const RESUME_BATCH_SIZE = 25;

function ensureQueueRunning(): void {
  if (!isProcessingQueue) {
    isProcessingQueue = true;
    setImmediate(runQueue);
  }
}

export async function enqueueSmsProcessingJob(job: SmsProcessingJob): Promise<void> {
  queue.push(job);
  ensureQueueRunning();
}

async function runQueue(): Promise<void> {
  while (queue.length > 0) {
    const job = queue.shift();

    if (!job) {
      continue;
    }

    await handleJob(job).catch((error: unknown) => {
      console.error("[sms-processor] Job failed", { job, error });
    });
  }

  isProcessingQueue = false;
}

async function resumeQueuedJobs(): Promise<void> {
  if (resumeInitialization) {
    return resumeInitialization;
  }

  resumeInitialization = (async () => {
    try {
      let lastId: number | undefined;

      for (;;) {
        const batch = await prisma.sms_messages.findMany({
          where: { status: { in: ["queued", "processing"] } },
          orderBy: { id: "asc" },
          take: RESUME_BATCH_SIZE,
          ...(lastId !== undefined
            ? {
                skip: 1,
                cursor: { id: lastId },
              }
            : {}),
          select: {
            id: true,
            owner: true,
            raw_text: true,
            sender_name: true,
            time: true,
            date_created: true,
            status: true,
          },
        });

        if (batch.length === 0) {
          break;
        }

        for (const record of batch) {
          if (!record.owner || !record.raw_text) {
            continue;
          }

          if (record.status !== "queued") {
            try {
              await prisma.sms_messages.update({
                where: { id: record.id },
                data: { status: "queued" },
              });
            } catch (error: unknown) {
              console.error("[sms-processor] Failed to reset stuck SMS status", {
                smsMessageId: record.id,
                error,
              });
              continue;
            }
          }

          const timestamp = record.time ?? record.date_created ?? new Date();
          const timestampIso = timestamp.toISOString();
          const job: SmsProcessingJob = {
            smsMessageId: record.id,
            userId: record.owner,
            sender: record.sender_name ?? "Unknown Sender",
            senderName: record.sender_name ?? "Unknown Sender",
            message: record.raw_text,
            timestampIso,
            datePart: timestampIso.slice(0, 10),
            timePart: timestampIso.slice(11, 19),
          };

          if (!queue.some((pending) => pending.smsMessageId === job.smsMessageId)) {
            queue.push(job);
          }
        }

        lastId = batch[batch.length - 1]?.id;

        if (batch.length < RESUME_BATCH_SIZE) {
          break;
        }
      }

      if (queue.length > 0) {
        console.log("[sms-processor] Resuming", queue.length, "queued SMS messages");
        ensureQueueRunning();
      }
    } catch (error: unknown) {
      console.error("[sms-processor] Failed to resume queued SMS jobs", error);
    }
  })();

  return resumeInitialization;
}

void resumeQueuedJobs();

/**
 * Process a single queued SMS message (used by cron job).
 * Returns outcome information for logging.
 */
export async function processQueuedSmsMessage(
  job: SmsProcessingJob,
  environment: DevEnvironment,
  // smsLog: SmsLog | undefined,
): Promise<{ status: string; details?: any }> {
  const acquired = await markJobAsProcessing(job);

  if (!acquired) {
    console.warn("[sms-processor] Skipping job; already processed or reassigned", job);
    return { status: "skipped", details: "already_processed" };
  }

  const smsPayload: any = {
    sender: job.sender,
    senderName: job.senderName,
    message: job.message,
    timestamp: job.timestampIso,
    date: job.datePart,
    time: job.timePart,
    ...(job.isFinancialFlag ? { is_financial: job.isFinancialFlag } : {}),
  };

  let outcome: ProcessSmsMessageOutcome;

  try {
    outcome = await processSmsMessageLocal(smsPayload, {
      devEnvironment: environment,
      meta: { originalSmsId: job.smsMessageId },
    });
  } catch (error: unknown) {
    await updateSmsStatusSafe(job.smsMessageId, "error", {
      processedAt: null,
      notes: "Processing failed: pipeline execution error",
      meta: {
        outcome: "error",
        error: "pipeline_failure",
        lastErrorAt: new Date().toISOString(),
      },
    });
    console.error("[sms-processor] Failed to process SMS", error);
    throw error;
  }

  const outcomeUpdate = buildOutcomeUpdate(outcome);
  await updateSmsStatusSafe(job.smsMessageId, outcomeUpdate.status, {
    processedAt: outcomeUpdate.processedAt,
    notes: outcomeUpdate.notes,
    meta: outcomeUpdate.meta,
  });

  if (outcome.status === "processed") {
    console.log("[sms-processor] SMS processed", {
      smsMessageId: job.smsMessageId,
      transactionId: outcome.result.normalized.id,
    });
    return {
      status: "processed",
      details: { transactionId: outcome.result.normalized.id },
    };
  } else if (outcome.status === "duplicate") {
    console.log("[sms-processor] SMS duplicate", {
      smsMessageId: job.smsMessageId,
      pendingId: outcome.pendingId,
    });
    return { status: "duplicate", details: { pendingId: outcome.pendingId } };
  } else if (outcome.status === "suppressed") {
    console.log("[sms-processor] SMS suppressed", {
      smsMessageId: job.smsMessageId,
      reason: outcome.reason,
    });
    return { status: "suppressed", details: { reason: outcome.reason } };
  } else {
    console.log("[sms-processor] SMS skipped", {
      smsMessageId: job.smsMessageId,
      reason: outcome.reason,
    });
    return { status: "skipped", details: { reason: outcome.reason } };
  }
}

async function handleJob(job: SmsProcessingJob): Promise<void> {
  const acquired = await markJobAsProcessing(job);

  if (!acquired) {
    console.warn("[sms-processor] Skipping job; already processed or reassigned", job);
    return;
  }

  let environment: DevEnvironment;
  try {
    environment = await resolveEnvironment();
  } catch (error: unknown) {
    await updateSmsStatusSafe(job.smsMessageId, "error", {
      processedAt: null,
      notes: "Processing failed: environment initialization error",
      meta: {
        outcome: "error",
        error: "environment_initialization_failure",
        lastErrorAt: new Date().toISOString(),
      },
    });
    console.error("[sms-processor] Failed to initialize Dev environment", error);
    return;
  }

  // const smsLog = await resolveSmsLog();

  const smsPayload: SmsMessage = {
    sender: job.sender,
    senderName: job.senderName,
    message: job.message,
    timestamp: job.timestampIso,
    date: job.datePart,
    time: job.timePart,
    ...(job.isFinancialFlag ? { is_financial: job.isFinancialFlag } : {}),
  };

  let outcome: ProcessSmsMessageOutcome;

  try {
    outcome = await processSmsMessageLocal(smsPayload, {
      devEnvironment: environment,
      meta: { originalSmsId: job.smsMessageId },
    });
  } catch (error: unknown) {
    await updateSmsStatusSafe(job.smsMessageId, "error", {
      processedAt: null,
      notes: "Processing failed: pipeline execution error",
      meta: {
        outcome: "error",
        error: "pipeline_failure",
        lastErrorAt: new Date().toISOString(),
      },
    });
    console.error("[sms-processor] Failed to process SMS", error);
    return;
  }

  const outcomeUpdate = buildOutcomeUpdate(outcome);
  await updateSmsStatusSafe(job.smsMessageId, outcomeUpdate.status, {
    processedAt: outcomeUpdate.processedAt,
    notes: outcomeUpdate.notes,
    meta: outcomeUpdate.meta,
  });

  if (outcome.status === "processed") {
    console.log("[sms-processor] SMS processed", {
      smsMessageId: job.smsMessageId,
      transactionId: outcome.result.normalized.id,
    });
  } else if (outcome.status === "duplicate") {
    console.log("[sms-processor] SMS duplicate", {
      smsMessageId: job.smsMessageId,
      pendingId: outcome.pendingId,
    });
  } else if (outcome.status === "suppressed") {
    console.log("[sms-processor] SMS suppressed", {
      smsMessageId: job.smsMessageId,
      reason: outcome.reason,
    });
  } else {
    console.log("[sms-processor] SMS skipped", {
      smsMessageId: job.smsMessageId,
      reason: outcome.reason,
    });
  }
}

/**
 * Local replacement for the removed `dev-sms-agent.processSmsMessage`.
 * Uses the regex extractor only (no LLM calls).
 */
export async function processSmsMessageLocal(
  message: {
    sender: string;
    senderName?: string;
    message: string;
    timestamp?: string;
    date?: string;
    time?: string;
    is_financial?: string;
  },
  options: { devEnvironment?: DevEnvironment; meta?: Record<string, any>; now?: string; defaultCurrency?: string } = {},
): Promise<ProcessSmsMessageOutcome> {
  // Basic financial check
  if (!isFinancial(message as any)) {
    return { status: "skipped", reason: "non-financial" };
  }

  // Use regex extractor (single message)
  const timestampMs = message.timestamp ? Date.parse(message.timestamp) : undefined;
  const extraction = extractWithRegex(message.message, timestampMs);
  const extractions = extraction ? [extraction] : [];

  if (!extractions || extractions.length === 0) {
    return { status: "skipped", reason: "non-financial" };
  }

  const extraction0 = extractions[0];

  let tools = options.devEnvironment?.tools;
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

  const payload = {
    amount: extraction0.amount,
    description: extraction0.description,
    category_suggestion: extraction0.category ?? "",
    type: extraction0.type === "credit" ? "credit" : "debit",
    raw_text: message.message,
  };

  const categorization = categorizeTransaction(payload.description, payload.amount);
  if (!payload.category_suggestion || payload.category_suggestion.length === 0) {
    payload.category_suggestion = categorization.inferredCategory;
  }

  const eventDetails = resolveEventOverrides(extraction0.date_of_transaction);
  const extraHeuristics = buildHeuristics(message as any, extraction0);
  if (typeof options.meta?.originalSmsId === "number") {
    extraHeuristics.push(`original-sms:${options.meta.originalSmsId}`);
  }
  const extraTags = buildTagsFromExtraction(extraction0);

  const pipelineMeta: NonNullable<any> = {
    ...(options.meta ?? {}),
  };

  if (extraction0.targetParty && extraction0.targetParty.length > 0) {
    pipelineMeta.targetParty = extraction0.targetParty;
  }

  if (extraction0.medium && extraction0.medium.length > 0) {
    pipelineMeta.medium = extraction0.medium;
  }

  const pipelineOptions: any = {
    tools,
    ...(environment?.alertManager ? { alertManager: environment.alertManager } : {}),
    source: "web-sms-ingest",
    defaultCurrency: extraction0.currency,
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

  const result = await runDevPipeline(payload as any, categorization, pipelineOptions);

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
      pendingId: Number(result.pendingId),
      candidate: result.normalized,
      duplicateOf: result.duplicateOf,
    };
  }

  const loggedResult: any = result;

  return { status: "processed", result: loggedResult };
}

// Helpers copied/adapted from previous SMS agent implementation
function isFinancial(message: { message: string; is_financial?: string }): boolean {
  const explicit = message.is_financial?.toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  const body = message.message.toLowerCase();
  return /rs\.|inr|credited|debited|dr\.|cr\./.test(body);
}

function resolveEventOverrides(timestamp: string): any {
  if (!timestamp) return {};
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return {};
  const date = new Date(parsed);
  const overrides: any = {};
  overrides.eventDate = formatDatePart(date);
  const timePart = formatTimePart(date);
  if (timePart) overrides.eventTime = timePart;
  return overrides;
}

function buildHeuristics(message: any, extraction: DevExtraction): string[] {
  const heuristics = new Set<string>();
  heuristics.add("source:sms-regex");
  heuristics.add(`medium:${extraction.medium}`);
  heuristics.add(`date_of_transaction:${extraction.date_of_transaction}`);
  if (extraction.targetParty.length > 0) heuristics.add(`target:${extraction.targetParty}`);
  if (message.sender) heuristics.add(`sender:${message.sender}`);
  if (message.senderName) heuristics.add(`sender-name:${message.senderName}`);
  if (message.timestamp) heuristics.add(`payload-ts:${message.timestamp}`);
  if (message.date) heuristics.add(`payload-date:${message.date}`);
  if (message.time) heuristics.add(`payload-time:${message.time}`);
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
  if (hours === 0 && minutes === 0 && seconds === 0) return undefined;
  return `${formatTwoDigits(hours)}:${formatTwoDigits(minutes)}`;
}

function formatTwoDigits(v: number): string {
  return v.toString().padStart(2, "0");
}

async function markJobAsProcessing(job: SmsProcessingJob): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      const smsMessages = tx.sms_messages as unknown as {
        findUnique: (args: unknown) => Promise<any>;
        update: (args: unknown) => Promise<any>;
      };

      const record = await smsMessages.findUnique({
        where: { id: job.smsMessageId },
        select: { status: true, owner: true, processing_meta: true },
      });

      if (!record || record.owner !== job.userId || record.status !== "queued") {
        return false;
      }

      const existingMeta = extractMetaRecord(record.processing_meta);
      const attemptNumber = resolveAttemptCount(existingMeta) + 1;
      const updatedMeta: Record<string, unknown> = {
        ...existingMeta,
        attempts: attemptNumber,
        lastAttemptAt: new Date().toISOString(),
      };

      const processingNote = `Processing attempt ${attemptNumber}`;

      await smsMessages.update({
        where: { id: job.smsMessageId },
        data: {
          status: "processing",
          processed_at: null,
          processing_notes: processingNote,
          processing_meta: updatedMeta as Prisma.JsonObject,
        },
      });

      return true;
    });
  } catch (error: unknown) {
    console.error("[sms-processor] Failed to mark job as processing", { job, error });
    return false;
  }
}

export async function resolveEnvironment(): Promise<DevEnvironment> {
  const pending = environmentPromise ?? createDevAgentEnvironment();
  environmentPromise = pending;

  try {
    return await pending;
  } catch (error: unknown) {
    environmentPromise = null;
    throw error;
  }
}

// TEMP: sms-log removed
// export async function resolveSmsLog(): Promise<SmsLog | undefined> {
//   if (!smsLogPromise) {
//     smsLogPromise = createSmsLog().catch((error: unknown) => {
//       console.error("[sms-processor] Failed to initialize SMS log", error);
//       return undefined;
//     });
//   }

//   try {
//     return await smsLogPromise;
//   } catch (error: unknown) {
//     smsLogPromise = null;
//     console.error("[sms-processor] SMS log initialization failed", error);
//     return undefined;
//   }
// }

interface StatusUpdateOptions {
  processedAt?: Date | null;
  notes?: string;
  meta?: Record<string, unknown>;
}

async function updateSmsStatusSafe(id: number, status: string, options: StatusUpdateOptions = {}): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const smsMessages = tx.sms_messages as unknown as {
        findUnique: (args: unknown) => Promise<any>;
        update: (args: unknown) => Promise<any>;
      };

      const existing = await smsMessages.findUnique({
        where: { id },
        select: { processing_meta: true },
      });

      const baseMeta = extractMetaRecord(existing?.processing_meta);
      const mergedMeta = options.meta ? { ...baseMeta, ...options.meta } : baseMeta;
      const shouldSetMeta = options.meta !== undefined || Object.keys(baseMeta).length > 0;

      await smsMessages.update({
        where: { id },
        data: {
          status,
          ...(options.processedAt !== undefined ? { processed_at: options.processedAt } : {}),
          ...(options.notes !== undefined ? { processing_notes: options.notes } : {}),
          ...(shouldSetMeta ? { processing_meta: mergedMeta as Prisma.JsonObject } : {}),
        },
      });
    });
  } catch (error: unknown) {
    console.error("[sms-processor] Failed to update SMS status", { id, status, error });
  }
}

interface OutcomeUpdate {
  status: string;
  processedAt: Date;
  notes: string;
  meta: Record<string, unknown>;
}

function buildOutcomeUpdate(outcome: ProcessSmsMessageOutcome): OutcomeUpdate {
  const processedAt = new Date();

  if (outcome.status === "processed") {
    return {
      status: "processed",
      processedAt,
      notes: `Transaction ${outcome.result.normalized.id} recorded`,
      meta: {
        outcome: "processed",
        transactionId: outcome.result.normalized.id,
        amount: outcome.result.normalized.amount,
        direction: outcome.result.normalized.direction,
        completedAt: processedAt.toISOString(),
      },
    };
  }

  if (outcome.status === "duplicate") {
    return {
      status: "duplicate",
      processedAt,
      notes: `Duplicate transaction detected (${outcome.pendingId})`,
      meta: {
        outcome: "duplicate",
        pendingId: outcome.pendingId,
        existingTransactionId: outcome.duplicateOf.id,
        completedAt: processedAt.toISOString(),
      },
    };
  }

  if (outcome.status === "suppressed") {
    return {
      status: "suppressed",
      processedAt,
      notes: `Suppressed duplicate candidate (${outcome.reason})`,
      meta: {
        outcome: "suppressed",
        reason: outcome.reason,
        duplicateOf: outcome.duplicateOf.id,
        completedAt: processedAt.toISOString(),
      },
    };
  }

  return {
    status: "skipped",
    processedAt,
    notes: `Skipped SMS (${outcome.reason})`,
    meta: {
      outcome: "skipped",
      reason: outcome.reason,
      completedAt: processedAt.toISOString(),
    },
  };
}

function extractMetaRecord(value: unknown): Record<string, unknown> {
  if (isJsonObject(value)) {
    return { ...value };
  }
  return {};
}

function resolveAttemptCount(meta: Record<string, unknown>): number {
  const rawAttempts = meta["attempts"];
  if (typeof rawAttempts === "number" && Number.isFinite(rawAttempts)) {
    return rawAttempts;
  }
  return 0;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
