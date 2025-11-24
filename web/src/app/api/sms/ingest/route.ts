import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { getUserContext } from "@/lib/auth-middleware";
import processAgentMessage from "@/lib/mill/in-process-adapter";
import { analyzeRawSMS, createFileSystemDevTools, runDevPipeline } from "@/runtime/dev/dev-agent";
import { categorizeTransaction } from "@/runtime/shared/categorize";

interface SmsIngestRequestBody {
  sender?: unknown;
  senderName?: unknown;
  message?: unknown;
  timestamp?: unknown;
  date?: unknown;
  time?: unknown;
  receiver?: unknown;
  receiverPhone?: unknown;
  receiver_phone_number?: unknown;
  isFinancial?: unknown;
  is_financial?: unknown;
}

export async function POST(request: Request) {
  const userContext = await getUserContext(request);

  if (!userContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const providedApiKey = normalizeHeaderValue(request.headers.get("x-sms-api-key"));

  if (!providedApiKey) {
    return NextResponse.json({ error: "Missing SMS API key" }, { status: 401 });
  }

  const userRecord = await prisma.users.findUnique({
    where: { id: userContext.userId },
    select: { sms_app_api_key: true },
  });

  if (!userRecord) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const allowedKeys = extractApiKeys(userRecord.sms_app_api_key);

  if (allowedKeys.length === 0 || !allowedKeys.some((key) => secureCompare(key, providedApiKey))) {
    return NextResponse.json({ error: "Invalid SMS API key" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as SmsIngestRequestBody | null;

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sender = normalizeBodyString(body.sender ?? body.senderName);
  const message = normalizeBodyString(body.message);

  if (!sender) {
    return NextResponse.json({ error: "'sender' is required" }, { status: 400 });
  }

  if (!message) {
    return NextResponse.json({ error: "'message' is required" }, { status: 400 });
  }

  if (message.length > 4000) {
    return NextResponse.json({ error: "Message exceeds maximum length (4000 characters)" }, { status: 413 });
  }

  const timestamp = parseTimestamp(body.timestamp);

  if (body.timestamp !== undefined && !timestamp) {
    return NextResponse.json({ error: "'timestamp' must be a valid ISO-8601 string or epoch milliseconds" }, { status: 400 });
  }

  const datePart = normalizeBodyString(body.date);
  const timePart = normalizeBodyString(body.time);

  const resolvedTimestamp = timestamp ?? new Date();
  const fallbackDate = resolvedTimestamp.toISOString().slice(0, 10);
  const fallbackTime = resolvedTimestamp.toISOString().slice(11, 19);

  const receiver =
    normalizePhoneValue(body.receiver) ??
    normalizePhoneValue(body.receiverPhone) ??
    normalizePhoneValue(body.receiver_phone_number);

  const explicitSenderName = normalizeBodyString(body.senderName);
  const isFinancialFlag = normalizeBodyString(body.is_financial ?? body.isFinancial ?? undefined);
  // Phase 0: store the raw SMS in the `sms_messages` table (best-effort).
  // We create a queued record so the existing cron/queue can also inspect it.
  try {
    await prisma.sms_messages.create({
      data: {
        status: "queued",
        raw_text: message,
        sender_name: sender ?? explicitSenderName ?? undefined,
        time: resolvedTimestamp,
        receiver_phone_number: receiver ?? undefined,
        owner: Number(userContext.userId),
      },
    });
  } catch (err) {
    // Do not abort ingest on DB failure; log for investigation.
    console.error("[sms/ingest] Failed to persist sms_messages row", err);
  }

  // Phase 1: send raw SMS to Dev for classification (no DB writes).
  try {
    const analysis = await analyzeRawSMS(message);

    // Build a structured event so the adapter and Mill can detect it reliably.
    const event = {
      type: "sms_ingest_event",
      analysis: analysis,
      original_text: message,
    } as const;

    // Trigger Mill via the in-process adapter. We send the structured event
    // as a JSON string so the adapter's JSON detector will start a Mill
    // conversation using the sms-ingest UX.
    const millResp = await processAgentMessage({
      userId: String(userContext.userId),
      message: JSON.stringify(event),
    });

    // Optionally schedule an automatic commit of the draft if no user reply.
    // Callers can request this behavior by adding `?auto_commit_after=<seconds>`
    // to the ingest URL. If omitted or <=0, no auto-commit is scheduled.
    try {
      const url = new URL(request.url);
      const autoCommitParam = url.searchParams.get("auto_commit_after");
      const autoSeconds = autoCommitParam ? Number(autoCommitParam) : 0;

      if (autoSeconds > 0) {
        const ownerId = Number(userContext.userId);
        // Safely extract draft data only when analysis indicates a draft
        const draft = (analysis && (analysis as any).status === 'draft') ? ((analysis as any).data ?? {}) : {};
        // Build a minimal payload for Dev pipeline from analysis
        const payload = {
          amount: typeof draft.amount === "number" ? draft.amount : 0,
          description: draft.merchant ? String(draft.merchant) : String(message).slice(0, 200),
          category_suggestion: draft.category ?? "Uncategorized",
          type: (draft.direction === "income") ? "credit" : "debit",
          raw_text: message,
        } as any;

        // Schedule delayed commit — server process must remain alive for this to run.
        setTimeout(async () => {
          try {
            const tools = await createFileSystemDevTools();
            const categorization = categorizeTransaction(payload.description ?? "", payload.amount ?? 0);
            await runDevPipeline(payload, categorization, { tools, meta: { ownerId } } as any);
            // best-effort: ignore result/errors, Dev pipeline will log
          } catch (err) {
            // swallow errors to avoid unhandled rejection in request lifecycle
            console.error("auto-commit failed", err);
          }
        }, Math.max(1000, Math.floor(autoSeconds * 1000)));
      }
    } catch (err) {
      console.error("Failed to schedule auto-commit", err);
    }

    return NextResponse.json({ status: "drafted", analysis, mill: millResp }, { status: 202 });
  } catch (err) {
    return NextResponse.json({ error: "Failed to classify SMS" }, { status: 500 });
  }
}

function normalizeHeaderValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBodyString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return null;
}

function normalizePhoneValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const digits = value.replace(/[^0-9+]/g, "");
  return digits.length > 0 ? digits : null;
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function extractApiKeys(source: unknown): string[] {
  const keys = new Set<string>();

  const visit = (value: unknown) => {
    if (!value) {
      return;
    }

    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized.length > 0) {
        keys.add(normalized);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(visit);
    }
  };

  visit(source);
  return Array.from(keys);
}

function secureCompare(candidate: string, provided: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const providedBuffer = Buffer.from(provided);

  if (candidateBuffer.length === 0 || candidateBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(candidateBuffer, providedBuffer);
}
