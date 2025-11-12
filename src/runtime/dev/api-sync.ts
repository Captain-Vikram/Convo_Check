import { fetch } from "undici";

import type { CategorizationResult } from "../shared/categorize.js";
import type { NormalizedTransaction } from "./transaction-normalizer.js";

type NormalizedAlert = NonNullable<NormalizedTransaction["meta"]["alerts"]>[number];

const DEFAULT_BASE_URL = "http://localhost:3000";
let syncTokenMissingWarned = false;
let fetchTokenMissingWarned = false;
const DEFAULT_FETCH_LIMIT = 50;

function isAuthDisabled(): boolean {
  const flag = process.env.DISABLE_AUTH;
  return flag === "1" || (typeof flag === "string" && flag.toLowerCase() === "true");
}

function toIsoTimestamp(eventDate: string, eventTime?: string): string {
  if (eventTime) {
    const isoWithTime = new Date(`${eventDate}T${eventTime}:00Z`).toISOString();
    return isoWithTime;
  }

  return new Date(`${eventDate}T00:00:00Z`).toISOString();
}

function buildPayload(transaction: NormalizedTransaction) {
  const direction = transaction.direction === "income" ? "credit" : "debit";
  const eventDate = toIsoTimestamp(transaction.eventDate, transaction.eventTime);
  const originalSmsId =
    typeof transaction.meta.originalSmsId === "number" && Number.isFinite(transaction.meta.originalSmsId)
      ? transaction.meta.originalSmsId
      : undefined;

  return {
    amount: transaction.amount,
    type: direction,
    description: transaction.description,
    category: transaction.category,
    medium: transaction.meta.medium ?? undefined,
    targetParty: transaction.meta.targetParty ?? undefined,
    eventDate,
    currency: transaction.currency ?? "INR",
    ...(originalSmsId !== undefined ? { originalSmsId } : {}),
  };
}

export async function syncTransactionToApi(transaction: NormalizedTransaction): Promise<void> {
  const serviceToken = process.env.SERVICE_API_TOKEN;
  const authDisabled = isAuthDisabled();

  if (!serviceToken && !authDisabled) {
    if (!syncTokenMissingWarned) {
      console.error("[api-sync] Cannot persist transactions; SERVICE_API_TOKEN is required.");
      syncTokenMissingWarned = true;
    }
    throw new Error("SERVICE_API_TOKEN is required for agent authentication");
  }

  const baseUrl = process.env.MILL_API_BASE_URL ?? DEFAULT_BASE_URL;
  const endpoint = new URL("/api/transactions", baseUrl).toString();
  const payload = buildPayload(transaction);

  const authTokenToUse = authDisabled ? null : serviceToken;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authTokenToUse ? { Authorization: `Bearer ${authTokenToUse}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "<no body>");
    throw new Error(`Transactions API rejected payload (${response.status}): ${errorBody}`);
  }
}

export async function fetchTransactionsFromApi(): Promise<NormalizedTransaction[]> {
  const serviceToken = process.env.SERVICE_API_TOKEN;
  const authDisabled = isAuthDisabled();

  console.log("[api-sync] Fetching transactions with:", {
    hasToken: !!serviceToken,
    tokenPrefix: serviceToken ? serviceToken.substring(0, 10) : "none",
    authDisabled,
  });

  if (!serviceToken && !authDisabled) {
    if (!fetchTokenMissingWarned) {
      console.error("[api-sync] Cannot fetch transactions; SERVICE_API_TOKEN is required.");
      fetchTokenMissingWarned = true;
    }
    throw new Error("SERVICE_API_TOKEN is required for agent authentication");
  }

  const baseUrl = process.env.MILL_API_BASE_URL ?? DEFAULT_BASE_URL;
  const limit = Number.parseInt(process.env.MILL_API_SEED_LIMIT ?? "", 10);
  const fetchLimit = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_FETCH_LIMIT;

  // If a seed owner is provided, request transactions for that owner.
  const seedOwner = process.env.MILL_API_SEED_OWNER ?? process.env.DEV_USER_ID;
  const ownerQuery = seedOwner ? `&owner=${encodeURIComponent(String(seedOwner))}` : "";
  const endpointUrl = new URL(`/api/transactions?limit=${fetchLimit}${ownerQuery}`, baseUrl).toString();

  const authTokenToUse = authDisabled ? null : serviceToken;

  const response = await fetch(endpointUrl, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...(authTokenToUse ? { Authorization: `Bearer ${authTokenToUse}` } : {}),
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "<no body>");
    throw new Error(`Transactions API fetch failed (${response.status}): ${errorBody}`);
  }

  const payload = await response.json().catch(() => null);
  if (!payload) {
    return [];
  }

  const records = extractTransactionsArray(payload);
  const normalized: NormalizedTransaction[] = [];

  for (const record of records) {
    const normalizedRecord = normalizeApiTransaction(record);
    if (normalizedRecord) {
      normalized.push(normalizedRecord);
    }
  }

  return normalized;
}

function extractTransactionsArray(payload: unknown): any[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === "object") {
    const maybeData = (payload as { data?: unknown; transactions?: unknown; items?: unknown });

    if (Array.isArray(maybeData.data)) {
      return maybeData.data;
    }

    if (Array.isArray(maybeData.transactions)) {
      return maybeData.transactions;
    }

    if (Array.isArray(maybeData.items)) {
      return maybeData.items;
    }
  }

  return [];
}

function normalizeApiTransaction(entry: any): NormalizedTransaction | null {
  const id = coerceString(entry?.id ?? entry?.transactionId);
  if (!id) {
    return null;
  }

  const recordedAt = coerceIsoTimestamp(entry?.recordedAt ?? entry?.createdAt ?? new Date().toISOString());
  const direction = resolveDirection(entry);
  const amount = coerceNumber(entry?.amount ?? entry?.value, 0);
  const currency = coerceString(entry?.currency ?? entry?.ccy, "INR");
  const description = coerceString(entry?.description ?? entry?.summary ?? "");
  const structuredSummary = coerceString(
    entry?.structuredSummary ?? entry?.metadata?.structuredSummary ?? description,
    description,
  );
  const rawText = coerceString(entry?.rawText ?? entry?.metadata?.rawText ?? description, description);
  const tags = coerceStringArray(entry?.tags ?? entry?.metadata?.tags);
  const flavor = resolveFlavor(entry?.flavor ?? entry?.metadata?.flavor);

  const { eventDate, eventTime } = resolveEventDate(entry?.eventDate ?? entry?.metadata?.eventDate, recordedAt);
  const source = coerceString(entry?.source ?? entry?.owner ?? entry?.metadata?.source, "transactions-api");
  const targetParty = coerceOptionalString(entry?.targetParty ?? entry?.metadata?.targetParty);
  const medium = coerceOptionalString(entry?.medium ?? entry?.metadata?.medium);
  const heuristics = coerceStringArray(entry?.metadata?.heuristics);

  if (heuristics.length === 0) {
    heuristics.push("api-import");
  }

  const normalized: NormalizedTransaction = {
    id,
    recordedAt,
    eventDate,
    ...(eventTime ? { eventTime } : {}),
    direction,
    amount,
    currency,
    category: coerceString(entry?.category ?? entry?.metadata?.category, "Uncategorized"),
    flavor,
    description,
    rawText,
    tags,
    structuredSummary,
    meta: {
      source,
      heuristics,
      ...(targetParty ? { targetParty } : {}),
      ...(medium ? { medium } : {}),
    },
  };

  const alerts = entry?.meta?.alerts ?? entry?.alerts ?? entry?.metadata?.alerts;
  if (Array.isArray(alerts)) {
    const normalizedAlerts: NormalizedAlert[] = [];

    for (const rawAlert of alerts) {
      if (!rawAlert || typeof rawAlert !== "object") {
        continue;
      }

      const identifier = coerceString(rawAlert.id ?? rawAlert.ruleId);
      const rule = coerceString(rawAlert.rule ?? rawAlert.ruleName);
      const severity = coerceString(rawAlert.severity);
      const summary = coerceString(rawAlert.summary ?? rawAlert.message ?? "");

      if (!identifier || !rule || !summary) {
        continue;
      }

      if (severity !== "low" && severity !== "medium" && severity !== "high") {
        continue;
      }

      normalizedAlerts.push({
        id: identifier,
        rule,
        severity,
        summary,
      });
    }

    if (normalizedAlerts.length > 0) {
      normalized.meta.alerts = normalizedAlerts;
    }
  }

  return normalized;
}

function resolveDirection(entry: any): NormalizedTransaction["direction"] {
  const rawDirection = coerceString(entry?.direction);
  if (rawDirection === "income" || rawDirection === "expense") {
    return rawDirection;
  }

  const type = coerceString(entry?.type);
  if (type === "credit") {
    return "income";
  }

  return "expense";
}

function resolveFlavor(value: unknown): CategorizationResult["flavor"] {
  if (value === "luxury" || value === "treat" || value === "necessity") {
    return value;
  }

  return "necessity";
}

function resolveEventDate(input: unknown, recordedAtIso: string): {
  eventDate: string;
  eventTime?: string;
} {
  if (typeof input === "string" && input.trim().length > 0) {
    const candidate = Date.parse(input);
    if (!Number.isNaN(candidate)) {
      const iso = new Date(candidate).toISOString();
      const [datePart, timePart] = iso.split("T");
      const time = timePart?.slice(0, 8);
      return {
        eventDate: datePart ?? recordedAtIso.split("T")[0] ?? new Date().toISOString().split("T")[0]!,
        ...(time && time !== "00:00:00" ? { eventTime: time } : {}),
      };
    }

    const sanitized = input.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(sanitized)) {
      return { eventDate: sanitized };
    }
  }

  const [fallbackDate, fallbackTimeRaw] = recordedAtIso.split("T");
  const fallbackTime = fallbackTimeRaw?.slice(0, 8);
  return {
    eventDate: fallbackDate ?? new Date().toISOString().split("T")[0]!,
    ...(fallbackTime && fallbackTime !== "00:00:00" ? { eventTime: fallbackTime } : {}),
  };
}

function coerceString(value: unknown, fallback = ""): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toString();
  }

  return fallback;
}

function coerceOptionalString(value: unknown): string | undefined {
  const coerced = coerceString(value);
  return coerced.length > 0 ? coerced : undefined;
}

function coerceIsoTimestamp(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  return new Date().toISOString();
}

function coerceNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => coerceString(entry))
      .filter((entry) => entry.length > 0);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value
      .split(/[|,]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return [];
}
