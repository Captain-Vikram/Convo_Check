import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { getUserContext } from "@/lib/auth-middleware";
import { enqueueSmsProcessingJob } from "@/lib/sms-processor";

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
  const userContext = getUserContext(request);

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

  const smsRecord = await prisma.sms_messages.create({
    data: {
      status: "queued",
      date_created: new Date(),
      raw_text: message,
      sender_name: sender,
      time: resolvedTimestamp,
      receiver_phone_number: receiver,
      owner: userContext.userId,
    },
    select: { id: true },
  });

  await enqueueSmsProcessingJob({
    smsMessageId: smsRecord.id,
    userId: userContext.userId,
    sender,
    senderName: explicitSenderName ?? sender,
    message,
    timestampIso: resolvedTimestamp.toISOString(),
    datePart: datePart ?? fallbackDate,
    timePart: timePart ?? fallbackTime,
    isFinancialFlag,
  });

  return NextResponse.json(
    {
      status: "queued",
      smsMessageId: smsRecord.id,
    },
    { status: 202 },
  );
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
