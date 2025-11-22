import { randomUUID } from "node:crypto";

import type { LogCashTransactionPayload } from "@/tools/log-cash-transaction";
import type { CategorizationResult } from "../shared/categorize";

export interface NormalizedTransaction {
  id: string;
  recordedAt: string;
  eventDate: string;
  eventTime?: string;
  direction: "expense" | "income";
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
    originalSmsId?: number;
    analyzedAt?: string; // ISO timestamp when analyzed by param agent
    analyzedVersion?: number; // Version of analysis logic used
    analysisNotes?: string; // Optional notes about analysis
    alerts?: Array<{
      id: string;
      rule: string;
      severity: "low" | "medium" | "high";
      summary: string;
    }>;
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
    originalSmsId?: number;
  };
  eventDateOverride?: string;
  eventTimeOverride?: string | null;
}

const DEFAULT_CURRENCY = "INR";

const CANONICAL_CATEGORIES = [
  "Food & Groceries",
  "Housing & Utilities",
  "Transport & Commute",
  "Health & Wellness",
  "Entertainment & Leisure",
  "Education & Learning",
  "Debt & EMI",
  "Savings & Investments",
  "Subscriptions & Services",
  "Shopping & Lifestyle",
  "Travel",
  "Fees & Charges",
  "Gifts & Donations",
  "Charity & Giving",
  "Business Expense",
  "Business Income",
  "Salary Income",
  "Side Hustle Income",
  "Refunds & Reimbursements",
  "Interest & Dividends",
  "Other Expense",
  "Other Income",
];

const CANONICAL_CATEGORY_LOOKUP = new Map(
  CANONICAL_CATEGORIES.map((category) => [category.toLowerCase(), category] as const),
);

const INCOME_CATEGORY_SET = new Set<string>([
  "Business Income",
  "Salary Income",
  "Side Hustle Income",
  "Refunds & Reimbursements",
  "Interest & Dividends",
  "Other Income",
]);

const CATEGORY_SYNONYMS: Record<string, string> = {
  groceries: "Food & Groceries",
  grocery: "Food & Groceries",
  food: "Food & Groceries",
  dining: "Food & Groceries",
  restaurant: "Food & Groceries",
  rent: "Housing & Utilities",
  electricity: "Housing & Utilities",
  utility: "Housing & Utilities",
  utilities: "Housing & Utilities",
  water: "Housing & Utilities",
  internet: "Housing & Utilities",
  wifi: "Housing & Utilities",
  transport: "Transport & Commute",
  commute: "Transport & Commute",
  cab: "Transport & Commute",
  taxi: "Transport & Commute",
  uber: "Transport & Commute",
  ola: "Transport & Commute",
  fuel: "Transport & Commute",
  petrol: "Transport & Commute",
  diesel: "Transport & Commute",
  healthcare: "Health & Wellness",
  medical: "Health & Wellness",
  medicine: "Health & Wellness",
  doctor: "Health & Wellness",
  gym: "Health & Wellness",
  fitness: "Health & Wellness",
  movie: "Entertainment & Leisure",
  entertainment: "Entertainment & Leisure",
  leisure: "Entertainment & Leisure",
  experiences: "Entertainment & Leisure",
  "celebration food": "Entertainment & Leisure",
  subscription: "Subscriptions & Services",
  subscriptions: "Subscriptions & Services",
  streaming: "Subscriptions & Services",
  netflix: "Subscriptions & Services",
  spotify: "Subscriptions & Services",
  prime: "Subscriptions & Services",
  education: "Education & Learning",
  tuition: "Education & Learning",
  course: "Education & Learning",
  emi: "Debt & EMI",
  loan: "Debt & EMI",
  creditcard: "Debt & EMI",
  credit: "Debt & EMI",
  shopping: "Shopping & Lifestyle",
  apparel: "Shopping & Lifestyle",
  clothes: "Shopping & Lifestyle",
  travel: "Travel",
  trip: "Travel",
  flight: "Travel",
  hotel: "Travel",
  fee: "Fees & Charges",
  charges: "Fees & Charges",
  fine: "Fees & Charges",
  penalty: "Fees & Charges",
  gift: "Gifts & Donations",
  donation: "Charity & Giving",
  charity: "Charity & Giving",
  business: "Business Expense",
  office: "Business Expense",
  software: "Business Expense",
  salary: "Salary Income",
  paycheck: "Salary Income",
  stipend: "Salary Income",
  payout: "Business Income",
  project: "Side Hustle Income",
  gig: "Side Hustle Income",
  reimbursement: "Refunds & Reimbursements",
  cashback: "Refunds & Reimbursements",
  interest: "Interest & Dividends",
  dividend: "Interest & Dividends",
  essentials: "Housing & Utilities",
  "food & dining": "Food & Groceries",
  "food and dining": "Food & Groceries",
  "food and groceries": "Food & Groceries",
  "high-value expense": "Other Expense",
  "general expense": "Other Expense",
  "everyday expense": "Other Expense",
  "gifts & giving": "Gifts & Donations",
  electronics: "Shopping & Lifestyle",
  "premium shopping": "Shopping & Lifestyle",
  "luxury expense": "Shopping & Lifestyle",
  allowance: "Salary Income",
  "pocket money": "Salary Income",
  wages: "Salary Income",
  bonus: "Salary Income",
  "side hustle": "Side Hustle Income",
  "side-hustle": "Side Hustle Income",
  freelance: "Side Hustle Income",
  vendor: "Business Expense",
  invoice: "Business Expense",
  "business income": "Business Income",
  "rental income": "Other Income",
  "interest income": "Interest & Dividends",
  income: "Other Income",
  "project income": "Side Hustle Income",
};

const CATEGORY_KEYWORD_RULES: Array<{
  category: string;
  keywords: RegExp[];
  direction?: "expense" | "income";
}> = [
  {
    category: "Food & Groceries",
    keywords: [/grocery/i, /food/i, /restaurant/i, /dinner/i, /lunch/i, /breakfast/i, /snack/i],
  },
  {
    category: "Transport & Commute",
    keywords: [/uber/i, /ola/i, /cab/i, /bus/i, /metro/i, /train/i, /fuel/i, /petrol/i, /diesel/i],
  },
  {
    category: "Housing & Utilities",
    keywords: [/rent/i, /electric/i, /utility/i, /water bill/i, /wifi/i, /internet/i],
  },
  {
    category: "Health & Wellness",
    keywords: [/doctor/i, /medicine/i, /pharmacy/i, /hospital/i, /clinic/i, /therapy/i, /gym/i],
  },
  {
    category: "Education & Learning",
    keywords: [/course/i, /tuition/i, /class/i, /exam/i, /education/i, /coaching/i],
  },
  {
    category: "Entertainment & Leisure",
    keywords: [/movie/i, /concert/i, /show/i, /gaming/i, /leisure/i, /netflix/i, /spotify/i, /prime/i],
  },
  {
    category: "Shopping & Lifestyle",
    keywords: [/shopping/i, /mall/i, /clothes/i, /fashion/i, /apparel/i, /lifestyle/i],
  },
  {
    category: "Travel",
    keywords: [/flight/i, /hotel/i, /trip/i, /travel/i, /vacation/i],
  },
  {
    category: "Fees & Charges",
    keywords: [/fee/i, /charge/i, /penalty/i, /late fee/i, /fine/i],
  },
  {
    category: "Business Expense",
    keywords: [/invoice/i, /vendor/i, /office/i, /software/i, /licen[cs]e/i, /subscription/i],
  },
  {
    category: "Salary Income",
    keywords: [/salary/i, /payroll/i, /payche?ck/i, /stipend/i],
    direction: "income",
  },
  {
    category: "Side Hustle Income",
    keywords: [/freelance/i, /gig/i, /side hustle/i, /client/i, /project/i, /paid me/i],
    direction: "income",
  },
  {
    category: "Business Income",
    keywords: [/payout/i, /invoice paid/i, /receivables/i, /payment from/i],
    direction: "income",
  },
  {
    category: "Refunds & Reimbursements",
    keywords: [/refund/i, /reimbursement/i, /cashback/i],
  },
  {
    category: "Interest & Dividends",
    keywords: [/interest/i, /dividend/i, /yield/i],
    direction: "income",
  },
  {
    category: "Savings & Investments",
    keywords: [/sip/i, /mutual fund/i, /investment/i, /stocks?/i, /crypto/i, /fd/i, /rd/i],
  },
  {
    category: "Gifts & Donations",
    keywords: [/gift/i, /wedding/i, /birthday/i, /present/i],
  },
  {
    category: "Charity & Giving",
    keywords: [/donation/i, /charity/i],
  },
];

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

  let eventDate = detection.eventDate;
  let eventTime = detection.eventTime;

  if (options.eventDateOverride) {
    eventDate = options.eventDateOverride;
  }

  if (options.eventTimeOverride !== undefined) {
    eventTime = options.eventTimeOverride ?? undefined;
  }

  const resolvedCategory = resolveCategory(payload, categorization);
  const tags = buildTags(resolvedCategory, payload, categorization, options.extraTags);

  const structuredSummary = buildSummary({
    payload,
    categorization,
    eventDate,
    currency,
    category: resolvedCategory,
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

  if (typeof options.meta?.originalSmsId === "number") {
    meta.originalSmsId = options.meta.originalSmsId;
  }

  return {
    id: randomUUID(),
    recordedAt: now.toISOString(),
    eventDate,
    ...(eventTime ? { eventTime } : {}),
    direction: payload.type === "credit" ? "income" : "expense",
    amount: payload.amount,
    currency,
  category: resolvedCategory,
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

function resolveCategory(
  payload: LogCashTransactionPayload,
  categorization: CategorizationResult,
): string {
  const direction = payload.type === "credit" ? "income" : "expense";
  const candidateSources = [payload.category_suggestion, categorization.inferredCategory];

  for (const candidate of candidateSources) {
    const mapped = mapCategoryCandidate(candidate, direction);
    if (mapped) {
      return mapped;
    }
  }

  const keywordCategory = matchCategoryByKeywords(
    `${payload.description} ${payload.raw_text}`,
    direction,
  );
  if (keywordCategory) {
    return keywordCategory;
  }

  return direction === "income" ? "Other Income" : "Other Expense";
}

function mapCategoryCandidate(
  value: string | undefined,
  direction: "expense" | "income",
): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = normalizeCategoryCandidate(value);
  if (!normalized) {
    return undefined;
  }

  const canonical = CANONICAL_CATEGORY_LOOKUP.get(normalized);
  if (canonical) {
    return alignCategoryWithDirection(canonical, direction);
  }

  const alias =
    CATEGORY_SYNONYMS[normalized] ?? CATEGORY_SYNONYMS[normalized.replace(/[\s&]+/g, "")];
  if (alias) {
    return alignCategoryWithDirection(alias, direction);
  }

  return undefined;
}

function normalizeCategoryCandidate(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9&\s]+/g, " ").replace(/\s+/g, " ").trim();
}

function matchCategoryByKeywords(
  text: string,
  direction: "expense" | "income",
): string | undefined {
  const haystack = text.toLowerCase();

  for (const rule of CATEGORY_KEYWORD_RULES) {
    if (rule.direction && rule.direction !== direction) {
      continue;
    }

    if (rule.keywords.some((keyword) => keyword.test(haystack))) {
      return alignCategoryWithDirection(rule.category, direction);
    }
  }

  return undefined;
}

function alignCategoryWithDirection(
  category: string,
  direction: "expense" | "income",
): string {
  if (direction === "income") {
    return INCOME_CATEGORY_SET.has(category) ? category : "Other Income";
  }

  return INCOME_CATEGORY_SET.has(category) ? "Other Expense" : category;
}

function toKebabCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
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
  category: string,
  payload: LogCashTransactionPayload,
  categorization: CategorizationResult,
  extraTags: string[] = [],
): string[] {
  const tags = new Set<string>();
  tags.add(payload.type === "credit" ? "income" : "expense");
  tags.add(categorization.flavor);
  tags.add(toKebabCase(category));

  if (payload.category_suggestion.trim().length > 0) {
    tags.add(toKebabCase(payload.category_suggestion));
  }

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
  category,
}: {
  payload: LogCashTransactionPayload;
  categorization: CategorizationResult;
  eventDate: string;
  currency: string;
  category: string;
}): string {
  const amountLabel = `${currency} ${payload.amount}`;
  const directionVerb = payload.type === "credit" ? "received" : "spent";
  const flavorNote = categorization.flavor === "luxury" ? "luxury" : categorization.flavor;
  return `${directionVerb} ${amountLabel} for ${payload.description} (${category}) on ${eventDate} (${flavorNote}).`;
}