import { randomUUID } from "node:crypto";

import type { LogCashTransactionPayload } from "../../tools/log-cash-transaction.js";
import type { CategorizationResult } from "../shared/categorize.js";

export interface NormalizedTransaction {
  id: string;
  recordedAt: string;
  eventDate: string;
  eventTime?: string;
  direction: LogCashTransactionPayload["direction"];
  amount: number;
  currency: string;
  category: string;
  flavor: CategorizationResult["flavor"];
  description: string;
  rawText: string;
  tags: string[];
  structuredSummary: string;
  meta: {
    source: string;
    heuristics: string[];
    rawCategorySuggestion?: string;
    parsedTemporalPhrase?: string;
    targetParty?: string;
    medium?: string;
  };
}

export interface NormalizeTransactionOptions {
  now?: Date;
  defaultCurrency?: string;
  source?: string;
  extraHeuristics?: string[];
  extraTags?: string[];
  meta?: {
    targetParty?: string;
    medium?: string;
  };
  eventDateOverride?: string;
  eventTimeOverride?: string | null;
}

const DEFAULT_CURRENCY = "INR";

export function normalizeTransaction(
  payload: LogCashTransactionPayload,
  categorization: CategorizationResult,
  options: NormalizeTransactionOptions = {},
): NormalizedTransaction {
  const now = options.now ?? new Date();
  const defaultCurrency = options.defaultCurrency ?? DEFAULT_CURRENCY;

  const heuristics: string[] = [];
  const detection = detectTemporalContext(
    payload.raw_text,
    now,
  );
  if (detection.temporalHeuristic) {
    heuristics.push(detection.temporalHeuristic);
  }

  if (options.extraHeuristics && options.extraHeuristics.length > 0) {
    heuristics.push(...options.extraHeuristics);
  }

  const currency = detectCurrency(payload.raw_text, defaultCurrency, heuristics);
  const tags = buildTags(payload, categorization, options.extraTags);

  let eventDate = detection.eventDate;
  let eventTime = detection.eventTime;

  if (options.eventDateOverride) {
    eventDate = options.eventDateOverride;
  }

  if (options.eventTimeOverride !== undefined) {
    eventTime = options.eventTimeOverride ?? undefined;
  }

  const structuredSummary = buildSummary({
    payload,
    categorization,
    eventDate,
    currency,
  });

  const meta: NormalizedTransaction["meta"] = {
    source: options.source ?? "mill-chat",
    heuristics,
    rawCategorySuggestion: payload.category_suggestion,
  };

  if (detection.parsedTemporalPhrase) {
    meta.parsedTemporalPhrase = detection.parsedTemporalPhrase;
  }

  if (options.meta?.targetParty) {
    meta.targetParty = options.meta.targetParty;
  }

  if (options.meta?.medium) {
    meta.medium = options.meta.medium;
  }

  return {
    id: randomUUID(),
    recordedAt: now.toISOString(),
    eventDate,
    ...(eventTime ? { eventTime } : {}),
    direction: payload.direction,
    amount: payload.amount,
    currency,
    category: payload.category_suggestion,
    flavor: categorization.flavor,
    description: payload.description,
    rawText: payload.raw_text,
    tags,
    structuredSummary,
    meta,
  };
}

function detectCurrency(rawText: string, fallback: string, heuristics: string[]): string {
  const normalized = rawText.toLowerCase();

  if (/\b(inr|₹|rs)\b/.test(normalized)) {
    heuristics.push("currency: detected INR glyph or token");
    return "INR";
  }

  if (/\b(usd|\$)\b/.test(normalized)) {
    heuristics.push("currency: detected USD marker");
    return "USD";
  }

  if (/\b(eur|€)\b/.test(normalized)) {
    heuristics.push("currency: detected EUR marker");
    return "EUR";
  }

  return fallback;
}

function detectTemporalContext(rawText: string, now: Date) {
  const normalized = rawText.toLowerCase();
  let temporalHeuristic: string | undefined;
  let parsedTemporalPhrase: string | undefined;
  let targetDate = new Date(now.getTime());
  let eventTime: string | undefined;

  const absoluteIsoMatch = rawText.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (absoluteIsoMatch) {
    targetDate = new Date(absoluteIsoMatch[0]);
    temporalHeuristic = "time: matched iso date";
    parsedTemporalPhrase = absoluteIsoMatch[0];
  }

  const slashDateMatch = rawText.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (slashDateMatch) {
    const [, dd, mm, yyRaw] = slashDateMatch;
    if (dd && mm && yyRaw) {
      const year = Number(yyRaw.length === 2 ? `20${yyRaw}` : yyRaw);
      targetDate = new Date(year, Number(mm) - 1, Number(dd));
      temporalHeuristic = "time: matched slash date";
      parsedTemporalPhrase = slashDateMatch[0];
    }
  }

  const shortDateMatch = rawText.match(/\b(\d{1,2})-(\d{1,2})\b/);
  if (!parsedTemporalPhrase && shortDateMatch) {
    const [, dd, mm] = shortDateMatch;
    const assumedYear = now.getFullYear();
    targetDate = new Date(assumedYear, Number(mm) - 1, Number(dd));
    temporalHeuristic = "time: matched short date";
    parsedTemporalPhrase = shortDateMatch[0];
  }

  if (!parsedTemporalPhrase) {
    const yesterdayMatch = rawText.match(/\b(yesterday|last night)\b/i);
    if (yesterdayMatch) {
      temporalHeuristic = "time: matched 'yesterday' phrase";
      parsedTemporalPhrase = yesterdayMatch[0];
      targetDate = shiftDate(now, -1);
    } else {
      const todayMatch = rawText.match(/\b(today|tonight|this morning)\b/i);
      if (todayMatch) {
        temporalHeuristic = "time: matched 'today' phrase";
        parsedTemporalPhrase = todayMatch[0];
      } else {
        const lastWeekMatch = rawText.match(/\b(last week)\b/i);
        if (lastWeekMatch) {
          temporalHeuristic = "time: matched 'last week' phrase";
          parsedTemporalPhrase = lastWeekMatch[0];
          targetDate = shiftDate(now, -7);
        }
      }
    }
  }

  const timeMatch = rawText.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (timeMatch) {
    const [, hourStr, minuteStr, meridiem] = timeMatch;
    const hour = Number(hourStr);
    const minute = minuteStr ? Number(minuteStr) : 0;
    const formattedTime = formatTime(hour, minute, meridiem);
    if (formattedTime) {
      eventTime = formattedTime;
      temporalHeuristic = temporalHeuristic ?? "time: matched explicit time";
    }
  }

  return {
    eventDate: formatISODate(targetDate),
    eventTime,
    temporalHeuristic,
    parsedTemporalPhrase,
  };
}

function shiftDate(date: Date, deltaDays: number): Date {
  const clone = new Date(date.getTime());
  clone.setDate(clone.getDate() + deltaDays);
  return clone;
}

function formatISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(hour: number, minute: number, meridiem?: string | null) {
  if (hour > 24 || minute > 59) {
    return undefined;
  }

  let normalizedHour = hour;
  if (meridiem) {
    const lower = meridiem.toLowerCase();
    if (lower === "pm" && hour < 12) {
      normalizedHour += 12;
    }
    if (lower === "am" && hour === 12) {
      normalizedHour = 0;
    }
  }

  const hh = String(normalizedHour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${hh}:${mm}`;
}

function buildTags(
  payload: LogCashTransactionPayload,
  categorization: CategorizationResult,
  extraTags: string[] = [],
): string[] {
  const tags = new Set<string>();
  tags.add(payload.direction);
  tags.add(categorization.flavor);
  tags.add(payload.category_suggestion.toLowerCase().replace(/\s+/g, "-"));

  if (/friends|party|celebration/i.test(payload.raw_text)) {
    tags.add("social");
  }

  if (/rent|bill|utility/i.test(payload.raw_text)) {
    tags.add("household");
  }

  for (const tag of extraTags) {
    if (!tag) {
      continue;
    }

    const trimmed = tag.trim();
    if (trimmed.length === 0) {
      continue;
    }

    tags.add(trimmed.toLowerCase());
  }

  return Array.from(tags);
}

function buildSummary({
  payload,
  categorization,
  eventDate,
  currency,
}: {
  payload: LogCashTransactionPayload;
  categorization: CategorizationResult;
  eventDate: string;
  currency: string;
}): string {
  const amountLabel = `${currency} ${payload.amount}`;
  const directionVerb = payload.direction === "income" ? "received" : "spent";
  const flavorNote = categorization.flavor === "luxury" ? "luxury" : categorization.flavor;
  return `${directionVerb} ${amountLabel} for ${payload.description} on ${eventDate} (${flavorNote}).`;
}