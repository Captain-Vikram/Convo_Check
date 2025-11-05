import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { NormalizedTransaction } from "./transaction-normalizer.js";

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
  baseDir: string;
  habitsFileName?: string;
}

const DEFAULT_HABITS_FILE = "habits.csv";
const EMPTY_PROFILES: BehaviorProfiles = {
  categories: new Map<string, BehaviorAggregate>(),
  targets: new Map<string, BehaviorAggregate>(),
};

export class BehaviorProfileCache {
  private readonly habitsFile: string;
  private cache: BehaviorProfiles | null = null;
  private cacheMtime = 0;

  constructor(options: BehaviorProfileCacheOptions) {
    this.habitsFile = join(options.baseDir, options.habitsFileName ?? DEFAULT_HABITS_FILE);
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
    try {
      const stats = await stat(this.habitsFile);
      if (this.cache && this.cacheMtime === stats.mtimeMs) {
        return this.cache;
      }

      const content = await readFile(this.habitsFile, "utf8");
      const parsed = parseHabitsCsv(content);
      this.cache = parsed;
      this.cacheMtime = stats.mtimeMs;
      return parsed;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code === "ENOENT") {
        this.cache = EMPTY_PROFILES;
        this.cacheMtime = 0;
        return EMPTY_PROFILES;
      }

      console.error("[behavior-profile] Failed to load habits data", error);
      if (this.cache) {
        return this.cache;
      }
      return EMPTY_PROFILES;
    }
  }
}

function parseHabitsCsv(content: string): BehaviorProfiles {
  const profiles: BehaviorProfiles = {
    categories: new Map<string, BehaviorAggregate>(),
    targets: new Map<string, BehaviorAggregate>(),
  };

  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    return profiles;
  }

  for (let index = 1; index < lines.length; index += 1) {
    const values = parseCsvLine(lines[index]!);
    if (values.length < 15) {
      continue;
    }

    const recordedAt = (values[1] ?? "").trim();
    const amountValue = pickAmount(values[4], values[10]);
    const targetPartyRaw = values[6]?.trim() ?? "";
    const categoryRaw = values[7]?.trim() ?? "";
    const frequencyRaw = values[9]?.trim() ?? "";
    const habitTypeRaw = values[13]?.trim() ?? "";
    const riskLevelRaw = values[14]?.trim() ?? "";

    const riskLevel = normalizeRiskLevel(riskLevelRaw);

    if (categoryRaw.length > 0) {
      const key = categoryRaw.toLowerCase();
      const aggregate = profiles.categories.get(key) ?? createAggregate();
      updateAggregate(aggregate, amountValue, recordedAt, riskLevel, habitTypeRaw, frequencyRaw);
      profiles.categories.set(key, aggregate);
    }

    if (targetPartyRaw.length > 0) {
      const key = targetPartyRaw.toLowerCase();
      const aggregate = profiles.targets.get(key) ?? createAggregate();
      updateAggregate(aggregate, amountValue, recordedAt, riskLevel, habitTypeRaw, frequencyRaw);
      profiles.targets.set(key, aggregate);
    }
  }

  return profiles;
}

function createAggregate(): BehaviorAggregate {
  return {
    entryCount: 0,
    amountCount: 0,
    amountMean: 0,
    amountM2: 0,
    amountMin: Number.POSITIVE_INFINITY,
    amountMax: Number.NEGATIVE_INFINITY,
    riskScoreSum: 0,
    highestRiskScore: 0,
    highestRiskLevel: "low",
    habitCounts: new Map<string, number>(),
    frequencyCounts: new Map<string, number>(),
  };
}

function updateAggregate(
  aggregate: BehaviorAggregate,
  amountValue: number | null,
  recordedAt: string,
  riskLevel: BehaviorRiskLevel,
  habitTypeRaw: string,
  frequencyRaw: string,
): void {
  aggregate.entryCount += 1;
  aggregate.riskScoreSum += riskLevelToScore(riskLevel);

  const riskScore = riskLevelToScore(riskLevel);
  if (riskScore > aggregate.highestRiskScore) {
    aggregate.highestRiskScore = riskScore;
    aggregate.highestRiskLevel = riskLevel;
  }

  if (amountValue !== null) {
    aggregate.amountCount += 1;
    const delta = amountValue - aggregate.amountMean;
    aggregate.amountMean += delta / aggregate.amountCount;
    aggregate.amountM2 += delta * (amountValue - aggregate.amountMean);
    aggregate.amountMin = Math.min(aggregate.amountMin, amountValue);
    aggregate.amountMax = Math.max(aggregate.amountMax, amountValue);
  }

  if (habitTypeRaw.trim().length > 0) {
    const key = habitTypeRaw.toLowerCase();
    aggregate.habitCounts.set(key, (aggregate.habitCounts.get(key) ?? 0) + 1);
  }

  if (frequencyRaw.trim().length > 0) {
    const key = frequencyRaw.toLowerCase();
    aggregate.frequencyCounts.set(key, (aggregate.frequencyCounts.get(key) ?? 0) + 1);
  }

  if (recordedAt && (aggregate.lastRecordedAt === undefined || recordedAt > aggregate.lastRecordedAt)) {
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

function pickAmount(primary: string | undefined, fallback: string | undefined): number | null {
  const primaryParsed = parseAmount(primary);
  if (primaryParsed !== null) {
    return primaryParsed;
  }
  return parseAmount(fallback);
}

function parseAmount(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }

  const normalized = raw.replace(/[^0-9.\-]/g, "");
  if (normalized.length === 0) {
    return null;
  }

  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) {
    return null;
  }

  return value;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      const next = line[index + 1];
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current);
  return result.map((entry) => entry.trim());
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
