import type { NormalizedTransaction } from "./transaction-normalizer";
import { prisma } from "@/lib/prisma";

// Small helper to retry Prisma operations when the query engine isn't ready.
async function prismaWithRetry<T>(fn: () => Promise<T>, retries = 4, delayMs = 500): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt += 1;
      const msg = err && err.message ? String(err.message) : "";
      const shouldRetry = attempt < retries && /Engine is not yet connected/i.test(msg);
      if (!shouldRetry) throw err;
      await new Promise((res) => setTimeout(res, delayMs * attempt));
    }
  }
}

export type BehaviorRiskLevel = "low" | "moderate" | "high";
export type BehaviorClassification =
  | "expected"
  | "borderline"
  | "unusual"
  | "flagged"
  | "insufficient";

interface BehaviorAggregate {
  entryCount: number;
  amountCount: number;
  amountMean: number;
  amountM2: number;
  amountMin: number;
  amountMax: number;
  riskScoreSum: number;
  highestRiskScore: number;
  highestRiskLevel: BehaviorRiskLevel;
  habitCounts: Map<string, number>;
  frequencyCounts: Map<string, number>;
  lastRecordedAt?: string;
}

interface BehaviorProfiles {
  categories: Map<string, BehaviorAggregate>;
  targets: Map<string, BehaviorAggregate>;
}

export interface BehaviorMatch {
  matchLevel: "target" | "category";
  label?: string;
  sampleCount: number;
  amountSampleCount: number;
  averageAmount: number | null;
  standardDeviation: number | null;
  minAmount: number | null;
  maxAmount: number | null;
  riskLevel: BehaviorRiskLevel;
  riskAverage: number | null;
  dominantHabitType?: string;
  dominantFrequency?: string;
  amountDelta: number | null;
  classification: BehaviorClassification;
  message: string;
  lastRecordedAt?: string;
}

export interface BehaviorAssessment {
  matches: BehaviorMatch[];
  bestMatch: BehaviorMatch | null;
}

export interface BehaviorProfileCacheOptions {
  // No longer uses file-based storage
  // Fetches from API instead
}

export class BehaviorProfileCache {
  private cache: BehaviorProfiles | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 60000; // 1 minute cache

  constructor(options: BehaviorProfileCacheOptions) {
    // No file path needed - uses API
  }

  async assess(transaction: NormalizedTransaction): Promise<BehaviorAssessment | null> {
    const profiles = await this.loadProfiles();
    if (!profiles) {
      return null;
    }

    const amount = transaction.amount;
    if (!Number.isFinite(amount)) {
      return null;
    }

    const matches: BehaviorMatch[] = [];
    const currency = transaction.currency || "inr";

    const targetKey = transaction.meta.targetParty?.trim().toLowerCase();
    if (targetKey) {
      const aggregate = profiles.targets.get(targetKey);
      if (aggregate) {
        matches.push(buildMatch(aggregate, "target", amount, currency, transaction.meta.targetParty));
      }
    }

    const categoryKey = transaction.category?.trim().toLowerCase();
    if (categoryKey) {
      const aggregate = profiles.categories.get(categoryKey);
      if (aggregate) {
        matches.push(buildMatch(aggregate, "category", amount, currency, transaction.category));
      }
    }

    if (matches.length === 0) {
      return null;
    }

    const prioritized = matches
      .slice()
      .sort((left, right) => {
        const levelScore = (match: BehaviorMatch) => (match.matchLevel === "target" ? 0 : 1);
        const levelComparison = levelScore(left) - levelScore(right);
        if (levelComparison !== 0) {
          return levelComparison;
        }

        const classificationComparison =
          classificationPriority(left.classification) - classificationPriority(right.classification);
        if (classificationComparison !== 0) {
          return classificationComparison;
        }

        return right.sampleCount - left.sampleCount;
      });

    return {
      matches,
      bestMatch: prioritized[0] ?? null,
    };
  }

  private async loadProfiles(): Promise<BehaviorProfiles> {
    const EMPTY_PROFILES: BehaviorProfiles = {
      categories: new Map<string, BehaviorAggregate>(),
      targets: new Map<string, BehaviorAggregate>(),
    };

    try {
      const now = Date.now();
      
      // Check cache validity
      if (this.cache && (now - this.cacheTimestamp) < this.CACHE_TTL_MS) {
        return this.cache;
      }

      // Load habit insights from the DB via Prisma and build profiles
      try {
        const habits = await prismaWithRetry(() =>
          prisma.habit_insights.findMany({
            orderBy: { recorded_at: "desc" },
            take: 1000,
          }),
        );

        if (!habits || habits.length === 0) {
          this.cache = EMPTY_PROFILES;
          this.cacheTimestamp = now;
          return EMPTY_PROFILES;
        }

        const profiles: BehaviorProfiles = {
          categories: new Map<string, BehaviorAggregate>(),
          targets: new Map<string, BehaviorAggregate>(),
        };

        for (const habit of habits) {
          const metadata = (habit.metrics && typeof habit.metrics === "object") ? habit.metrics as any : {};
          const category = metadata.category || habit.habit_label || "";
          const targetParty = metadata.targetParty || "";

          if (category) {
            updateAggregateFromApiHabit(profiles.categories, category.toLowerCase(), habit as any);
          }

          if (targetParty) {
            updateAggregateFromApiHabit(profiles.targets, targetParty.toLowerCase(), habit as any);
          }
        }

        this.cache = profiles;
        this.cacheTimestamp = now;
        return profiles;
      } catch (err) {
        console.error("[behavior-profile] Failed to load habits from DB via Prisma", err);
        this.cache = EMPTY_PROFILES;
        this.cacheTimestamp = now;
        return EMPTY_PROFILES;
      }
    } catch (error) {
      console.error("[behavior-profile] Failed to load habits from API", error);
      if (this.cache) {
        return this.cache;
      }
      return EMPTY_PROFILES;
    }
  }
}

function updateAggregateFromApiHabit(
  map: Map<string, BehaviorAggregate>,
  key: string,
  habit: any
): void {
  let aggregate = map.get(key);
  
  if (!aggregate) {
    aggregate = {
      entryCount: 0,
      amountCount: 0,
      amountMean: 0,
      amountM2: 0,
      amountMin: Number.POSITIVE_INFINITY,
      amountMax: Number.NEGATIVE_INFINITY,
      riskScoreSum: 0,
      highestRiskScore: 0,
      highestRiskLevel: "low" as BehaviorRiskLevel,
      habitCounts: new Map<string, number>(),
      frequencyCounts: new Map<string, number>(),
    };
    map.set(key, aggregate);
  }

  aggregate.entryCount++;
  
  const amount = habit.average_amount;
  if (typeof amount === "number" && Number.isFinite(amount)) {
    aggregate.amountCount++;
    const delta = amount - aggregate.amountMean;
    aggregate.amountMean += delta / aggregate.amountCount;
    aggregate.amountM2 += delta * (amount - aggregate.amountMean);
    aggregate.amountMin = Math.min(aggregate.amountMin, amount);
    aggregate.amountMax = Math.max(aggregate.amountMax, amount);
  }

  const riskLevel = habit.risk_level || "low";
  const riskScore = riskLevel === "high" ? 3 : riskLevel === "moderate" ? 2 : 1;
  aggregate.riskScoreSum += riskScore;
  if (riskScore > aggregate.highestRiskScore) {
    aggregate.highestRiskScore = riskScore;
    aggregate.highestRiskLevel = riskLevel;
  }

  const habitType = habit.habit_type || habit.metrics?.habitType || "";
  if (habitType) {
    aggregate.habitCounts.set(habitType, (aggregate.habitCounts.get(habitType) || 0) + 1);
  }

  const frequency = habit.frequency || habit.metrics?.frequency || "";
  if (frequency) {
    aggregate.frequencyCounts.set(frequency, (aggregate.frequencyCounts.get(frequency) || 0) + 1);
  }

  const recordedAt = habit.created_at || new Date().toISOString();
  if (!aggregate.lastRecordedAt || recordedAt > aggregate.lastRecordedAt) {
    aggregate.lastRecordedAt = recordedAt;
  }
}

function buildMatch(
  aggregate: BehaviorAggregate,
  matchLevel: BehaviorMatch["matchLevel"],
  transactionAmount: number,
  currency: string,
  label?: string,
): BehaviorMatch {
  const amountSamples = aggregate.amountCount;
  const mean = amountSamples > 0 ? aggregate.amountMean : null;
  const stdev = amountSamples > 1 ? Math.sqrt(aggregate.amountM2 / (amountSamples - 1)) : null;
  const amountDelta = mean && mean !== 0 ? Math.abs(transactionAmount - mean) / mean : null;
  const classification = classifyBehavior(aggregate, transactionAmount, amountDelta, stdev);
  const riskAverage = aggregate.entryCount > 0 ? aggregate.riskScoreSum / aggregate.entryCount : null;
  const dominantHabitType = getDominantKey(aggregate.habitCounts);
  const dominantFrequency = getDominantKey(aggregate.frequencyCounts);

  const message = formatBehaviorMessage({
    matchLevel,
    classification,
    transactionAmount,
    currency,
    mean,
    amountDelta,
    samples: amountSamples,
    riskLevel: aggregate.highestRiskLevel,
    ...(label ? { label } : {}),
    ...(dominantHabitType ? { dominantHabitType } : {}),
    ...(dominantFrequency ? { dominantFrequency } : {}),
  });

  const match: BehaviorMatch = {
    matchLevel,
    sampleCount: aggregate.entryCount,
    amountSampleCount: amountSamples,
    averageAmount: mean !== null && Number.isFinite(mean) ? roundAmount(mean) : null,
    standardDeviation: stdev !== null && Number.isFinite(stdev) ? roundAmount(stdev) : null,
    minAmount:
      amountSamples > 0 && Number.isFinite(aggregate.amountMin) ? roundAmount(aggregate.amountMin) : null,
    maxAmount:
      amountSamples > 0 && Number.isFinite(aggregate.amountMax) ? roundAmount(aggregate.amountMax) : null,
    riskLevel: aggregate.highestRiskLevel,
    riskAverage: riskAverage !== null && Number.isFinite(riskAverage) ? roundAmount(riskAverage) : null,
    amountDelta: amountDelta !== null && Number.isFinite(amountDelta) ? roundRatio(amountDelta) : null,
    classification,
    message,
  };

  if (label) {
    match.label = label;
  }

  if (dominantHabitType) {
    match.dominantHabitType = dominantHabitType;
  }

  if (dominantFrequency) {
    match.dominantFrequency = dominantFrequency;
  }

  if (aggregate.lastRecordedAt) {
    match.lastRecordedAt = aggregate.lastRecordedAt;
  }

  return match;
}

function classifyBehavior(
  aggregate: BehaviorAggregate,
  transactionAmount: number,
  amountDelta: number | null,
  stdev: number | null,
): BehaviorClassification {
  if (aggregate.highestRiskScore >= 3) {
    return "flagged";
  }

  if (aggregate.amountCount === 0 || !Number.isFinite(transactionAmount)) {
    return "insufficient";
  }

  if (aggregate.amountCount < 2) {
    if (amountDelta !== null && amountDelta <= 0.2) {
      return "expected";
    }
    return "borderline";
  }

  if (stdev && stdev > 0) {
    const zScore = Math.abs(transactionAmount - aggregate.amountMean) / stdev;
    if (zScore <= 1) {
      return "expected";
    }
    if (zScore <= 2) {
      return "borderline";
    }
    return "unusual";
  }

  if (amountDelta === null || !Number.isFinite(amountDelta)) {
    return "insufficient";
  }

  if (amountDelta <= 0.25) {
    return "expected";
  }

  if (amountDelta <= 0.6) {
    return "borderline";
  }

  return "unusual";
}

function formatBehaviorMessage(params: {
  matchLevel: BehaviorMatch["matchLevel"];
  label?: string;
  classification: BehaviorClassification;
  transactionAmount: number;
  currency: string;
  mean: number | null;
  amountDelta: number | null;
  dominantHabitType?: string;
  dominantFrequency?: string;
  samples: number;
  riskLevel: BehaviorRiskLevel;
}): string {
  const { matchLevel, label, classification, transactionAmount, currency, mean, amountDelta, dominantHabitType, dominantFrequency, samples, riskLevel } = params;
  const matchLabel = matchLevel === "target" ? label ?? "this payee" : label ?? "this category";
  const meanLabel = mean !== null ? formatCurrency(currency, mean) : "no baseline amount";
  const amountLabel = formatCurrency(currency, transactionAmount);
  const deltaLabel = amountDelta !== null ? `${Math.round(amountDelta * 100)}%` : "unknown";
  const frequencyLabel = dominantFrequency ? dominantFrequency : undefined;
  const habitLabel = dominantHabitType ? dominantHabitType : undefined;

  switch (classification) {
    case "expected": {
      const descriptors = [] as string[];
      if (habitLabel) {
        descriptors.push(`${habitLabel} habit`);
      }
      if (frequencyLabel) {
        descriptors.push(`typically ${frequencyLabel}`);
      }
      const descriptorText = descriptors.length > 0 ? ` (${descriptors.join(", ")})` : "";
      return `Matches ${matchLabel}${descriptorText}: usually ${meanLabel} over ${samples} samples.`;
    }
    case "borderline":
      return `Borderline for ${matchLabel}: ${amountLabel} is ${deltaLabel} away from typical ${meanLabel}.`;
    case "unusual":
      return `Unusual for ${matchLabel}: ${amountLabel} deviates ${deltaLabel} from baseline ${meanLabel}.`;
    case "flagged":
      return `Historical habits mark ${matchLabel} as high risk (${riskLevel}).`;
    default:
      return `Behavior context limited for ${matchLabel}.`;
  }
}

function normalizeRiskLevel(raw: string): BehaviorRiskLevel {
  const candidate = raw.trim().toLowerCase();
  if (candidate === "low" || candidate === "moderate" || candidate === "high") {
    return candidate;
  }
  return "moderate";
}

function riskLevelToScore(level: BehaviorRiskLevel): number {
  switch (level) {
    case "low":
      return 1;
    case "high":
      return 3;
    default:
      return 2;
  }
}

function getDominantKey(source: Map<string, number>): string | undefined {
  let bestKey: string | undefined;
  let bestCount = 0;

  for (const [key, count] of source.entries()) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }

  return bestKey;
}

function formatCurrency(currency: string, amount: number): string {
  const formatter = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency.toUpperCase() || "INR",
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  });

  return formatter.format(amount);
}

function roundAmount(value: number): number {
  return Number.parseFloat(value.toFixed(2));
}

function roundRatio(value: number): number {
  return Number.parseFloat(value.toFixed(2));
}

function classificationPriority(classification: BehaviorClassification): number {
  switch (classification) {
    case "flagged":
      return 0;
    case "unusual":
      return 1;
    case "borderline":
      return 2;
    case "expected":
      return 3;
    default:
      return 4;
  }
}
