import { createDevAgentEnvironment } from "../../../src/runtime/dev/dev-agent";
import {
  processSmsMessage,
  type ProcessSmsMessageOutcome,
  type SmsMessage,
} from "../../../src/runtime/dev/dev-sms-agent";
import { createSmsLog, type SmsLog } from "../../../src/runtime/dev/sms-log";
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

type DevEnvironment = Awaited<ReturnType<typeof createDevAgentEnvironment>>;

let environmentPromise: Promise<DevEnvironment> | null = null;
let smsLogPromise: Promise<SmsLog | undefined> | null = null;

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
  smsLog: SmsLog | undefined,
): Promise<{ status: string; details?: any }> {
  const acquired = await markJobAsProcessing(job);

  if (!acquired) {
    console.warn("[sms-processor] Skipping job; already processed or reassigned", job);
    return { status: "skipped", details: "already_processed" };
  }

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
    outcome = await processSmsMessage(smsPayload, {
      devEnvironment: environment,
      smsLog: smsLog ?? undefined,
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

  const smsLog = await resolveSmsLog();

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
    outcome = await processSmsMessage(smsPayload, {
      devEnvironment: environment,
      smsLog: smsLog ?? undefined,
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

export async function resolveSmsLog(): Promise<SmsLog | undefined> {
  if (!smsLogPromise) {
    smsLogPromise = createSmsLog().catch((error: unknown) => {
      console.error("[sms-processor] Failed to initialize SMS log", error);
      return undefined;
    });
  }

  try {
    return await smsLogPromise;
  } catch (error: unknown) {
    smsLogPromise = null;
    console.error("[sms-processor] SMS log initialization failed", error);
    return undefined;
  }
}

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
