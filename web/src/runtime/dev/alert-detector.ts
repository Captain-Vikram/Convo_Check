import type { NormalizedTransaction } from "./transaction-normalizer";

export type AlertRuleId =
  | "rapid_burst"
  | "repeat_payee"
  | "large_withdrawal"
  | "unusual_credit";
export type AlertSeverity = "low" | "medium" | "high";

export interface AlertMetricTransaction {
  id: string;
  timestamp: string;
  amount: number;
  direction: "income" | "expense";
  targetParty?: string;
}

export interface AlertMetricsState {
  recentTransactions: AlertMetricTransaction[];
  incomeSamples: number[];
  expenseSamples: number[];
}

export interface DetectedAlert {
  rule: AlertRuleId;
  severity: AlertSeverity;
  confidence: number;
  summary: string;
  details?: Record<string, unknown>;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TWO_MINUTES_MS = 2 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const THREE_MINUTES_MS = 3 * 60 * 1000;

const MAX_RECENT_TRANSACTIONS = 150;
const MAX_INCOME_SAMPLES = 32;
const MAX_EXPENSE_SAMPLES = 48;

const RAPID_BURST_MEDIUM_COUNT = 5;
const RAPID_BURST_HIGH_COUNT = 8;

const REPEAT_PAYEE_MEDIUM_COUNT = 4;
const REPEAT_PAYEE_HIGH_COUNT = 8;

const LARGE_WITHDRAWAL_MEDIUM_FACTOR = 1.8;
const LARGE_WITHDRAWAL_HIGH_FACTOR = 2.5;

const UNUSUAL_CREDIT_MEDIUM_FACTOR = 1.75;
const UNUSUAL_CREDIT_HIGH_FACTOR = 2.5;

export function createEmptyMetrics(): AlertMetricsState {
  return {
    recentTransactions: [],
    incomeSamples: [],
    expenseSamples: [],
  };
}

export function detectAnomalies(
  transaction: NormalizedTransaction,
  metrics: AlertMetricsState,
): { alerts: DetectedAlert[]; timestamp?: number } {
  const timestamp = resolveTimestamp(transaction);
  if (timestamp === undefined) {
    return { alerts: [] };
  }

  const alerts: DetectedAlert[] = [];
  const normalizedParty = transaction.meta.targetParty?.trim().toLowerCase();

  const fiveMinuteDirectionWindow = selectTransactions(metrics.recentTransactions, timestamp, FIVE_MINUTES_MS, (entry) => entry.direction === transaction.direction);
  const twoMinuteDirectionWindow = selectTransactions(metrics.recentTransactions, timestamp, TWO_MINUTES_MS, (entry) => entry.direction === transaction.direction);

  const fiveMinuteCount = fiveMinuteDirectionWindow.length + 1;
  const twoMinuteCount = twoMinuteDirectionWindow.length + 1;

  if (twoMinuteCount >= RAPID_BURST_HIGH_COUNT) {
    const totalAmount = twoMinuteDirectionWindow.reduce((sum, entry) => sum + entry.amount, transaction.amount);
    alerts.push({
      rule: "rapid_burst",
      severity: "high",
      confidence: Math.min(0.95, 0.6 + twoMinuteCount * 0.08),
      summary: `${formatCurrency(transaction.currency, totalAmount)} across ${twoMinuteCount} ${
        transaction.direction === "income" ? "credits" : "debits"
      } within 2 minutes. Latest: ${formatCurrency(transaction.currency, transaction.amount)}.`,
      details: {
        burstCount: twoMinuteCount,
        windowMinutes: 2,
        totalAmount,
      },
    });
  } else if (fiveMinuteCount >= RAPID_BURST_MEDIUM_COUNT) {
    const totalAmount = fiveMinuteDirectionWindow.reduce((sum, entry) => sum + entry.amount, transaction.amount);
    alerts.push({
      rule: "rapid_burst",
      severity: "medium",
      confidence: Math.min(0.9, 0.55 + fiveMinuteCount * 0.06),
      summary: `${formatCurrency(transaction.currency, totalAmount)} across ${fiveMinuteCount} ${
        transaction.direction === "income" ? "credits" : "debits"
      } within 5 minutes. Latest: ${formatCurrency(transaction.currency, transaction.amount)}.`,
      details: {
        burstCount: fiveMinuteCount,
        windowMinutes: 5,
        totalAmount,
      },
    });
  }

  if (normalizedParty && transaction.direction === "expense") {
    const threeMinuteWindow = selectTransactions(
      metrics.recentTransactions,
      timestamp,
      THREE_MINUTES_MS,
      (entry) => {
        if (entry.direction !== "expense") {
          return false;
        }
        if (!entry.targetParty) {
          return false;
        }
        return entry.targetParty.trim().toLowerCase() === normalizedParty;
      },
    );
    const oneMinuteWindow = selectTransactions(
      metrics.recentTransactions,
      timestamp,
      ONE_MINUTE_MS,
      (entry) => {
        if (entry.direction !== "expense") {
          return false;
        }
        if (!entry.targetParty) {
          return false;
        }
        return entry.targetParty.trim().toLowerCase() === normalizedParty;
      },
    );

    const threeMinuteCount = threeMinuteWindow.length + 1;
    const oneMinuteCount = oneMinuteWindow.length + 1;
    const threeMinuteTotal = threeMinuteWindow.reduce((sum, entry) => sum + entry.amount, transaction.amount);
    const oneMinuteTotal = oneMinuteWindow.reduce((sum, entry) => sum + entry.amount, transaction.amount);

    if (oneMinuteCount >= REPEAT_PAYEE_HIGH_COUNT || oneMinuteTotal >= 25000) {
      alerts.push({
        rule: "repeat_payee",
        severity: "high",
        confidence: Math.min(0.97, 0.65 + oneMinuteCount * 0.05),
        summary: `${oneMinuteCount} rapid payments to ${transaction.meta.targetParty} totaling ${formatCurrency(
          transaction.currency,
          oneMinuteTotal,
        )} within a minute.`,
        details: {
          repeatCount: oneMinuteCount,
          combined: oneMinuteTotal,
          target: transaction.meta.targetParty,
          windowSeconds: 60,
        },
      });
    } else if (threeMinuteCount >= REPEAT_PAYEE_MEDIUM_COUNT) {
      alerts.push({
        rule: "repeat_payee",
        severity: "medium",
        confidence: Math.min(0.92, 0.6 + threeMinuteCount * 0.06),
        summary: `${threeMinuteCount} quick payments to ${transaction.meta.targetParty} totaling ${formatCurrency(
          transaction.currency,
          threeMinuteTotal,
        )} within a few minutes.`,
        details: {
          repeatCount: threeMinuteCount,
          combined: threeMinuteTotal,
          target: transaction.meta.targetParty,
          windowSeconds: 180,
        },
      });
    }
  }

  if (transaction.direction === "expense") {
    const expenseBaseline = resolveExpenseAlertBaseline(metrics.expenseSamples, metrics.incomeSamples);

    if (expenseBaseline !== undefined) {
      const mediumThreshold = expenseBaseline * LARGE_WITHDRAWAL_MEDIUM_FACTOR;
      const highThreshold = expenseBaseline * LARGE_WITHDRAWAL_HIGH_FACTOR;

      if (transaction.amount >= highThreshold) {
        alerts.push({
          rule: "large_withdrawal",
          severity: "high",
          confidence: Math.min(0.99, transaction.amount / highThreshold),
          summary: `Debit of ${formatCurrency(transaction.currency, transaction.amount)} is far above your usual spending pattern.`,
          details: {
            baseline: expenseBaseline,
            threshold: highThreshold,
          },
        });
      } else if (transaction.amount >= mediumThreshold) {
        alerts.push({
          rule: "large_withdrawal",
          severity: "medium",
          confidence: Math.min(0.9, transaction.amount / mediumThreshold),
          summary: `Debit of ${formatCurrency(transaction.currency, transaction.amount)} is higher than your typical spend.`,
          details: {
            baseline: expenseBaseline,
            threshold: mediumThreshold,
          },
        });
      }
    }
  }

  if (transaction.direction === "income") {
    const incomeBaseline = resolveIncomeAlertBaseline(metrics.incomeSamples);

    if (incomeBaseline !== undefined) {
      const mediumThreshold = incomeBaseline * UNUSUAL_CREDIT_MEDIUM_FACTOR;
      const highThreshold = incomeBaseline * UNUSUAL_CREDIT_HIGH_FACTOR;

      if (transaction.amount >= highThreshold) {
        alerts.push({
          rule: "unusual_credit",
          severity: "high",
          confidence: Math.min(0.98, transaction.amount / highThreshold),
          summary: `Credit of ${formatCurrency(transaction.currency, transaction.amount)} is well above your usual incoming transfers.`,
          details: {
            baseline: incomeBaseline,
            threshold: highThreshold,
          },
        });
      } else if (transaction.amount >= mediumThreshold) {
        alerts.push({
          rule: "unusual_credit",
          severity: "medium",
          confidence: Math.min(0.9, transaction.amount / mediumThreshold),
          summary: `Credit of ${formatCurrency(transaction.currency, transaction.amount)} looks larger than normal.`,
          details: {
            baseline: incomeBaseline,
            threshold: mediumThreshold,
          },
        });
      }
    }
  }

  return { alerts, timestamp };
}

export function updateMetrics(
  metrics: AlertMetricsState,
  transaction: NormalizedTransaction,
  timestamp: number,
): void {
  const entry: AlertMetricTransaction = {
    id: transaction.id,
    timestamp: new Date(timestamp).toISOString(),
    amount: transaction.amount,
    direction: transaction.direction,
    ...(transaction.meta.targetParty ? { targetParty: transaction.meta.targetParty } : {}),
  };

  metrics.recentTransactions.push(entry);
  while (metrics.recentTransactions.length > MAX_RECENT_TRANSACTIONS) {
    metrics.recentTransactions.shift();
  }

  if (transaction.direction === "income" && transaction.amount > 0) {
    metrics.incomeSamples.push(transaction.amount);
    while (metrics.incomeSamples.length > MAX_INCOME_SAMPLES) {
      metrics.incomeSamples.shift();
    }
  }

  if (transaction.direction === "expense" && transaction.amount > 0) {
    metrics.expenseSamples.push(transaction.amount);
    while (metrics.expenseSamples.length > MAX_EXPENSE_SAMPLES) {
      metrics.expenseSamples.shift();
    }
  }
}

function resolveTimestamp(transaction: NormalizedTransaction): number | undefined {
  if (transaction.eventDate) {
    if (transaction.eventTime) {
      const candidate = Date.parse(`${transaction.eventDate}T${transaction.eventTime}`);
      if (!Number.isNaN(candidate)) {
        return candidate;
      }
    }

    const candidate = Date.parse(transaction.eventDate);
    if (!Number.isNaN(candidate)) {
      return candidate;
    }
  }

  const recorded = Date.parse(transaction.recordedAt);
  if (!Number.isNaN(recorded)) {
    return recorded;
  }

  return undefined;
}

function calculateMedian(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[midpoint - 1]! + sorted[midpoint]!) / 2;
  }

  return sorted[midpoint] ?? 0;
}

function formatCurrency(currency: string, amount: number): string {
  const formatter = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency.toUpperCase() || "INR",
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  });

  return formatter.format(amount);
}

function selectTransactions(
  recentTransactions: AlertMetricTransaction[],
  timestamp: number,
  windowMs: number,
  predicate?: (entry: AlertMetricTransaction) => boolean,
): AlertMetricTransaction[] {
  return recentTransactions.filter((entry) => {
    const entryTs = Date.parse(entry.timestamp);
    if (Number.isNaN(entryTs)) {
      return false;
    }

    if (timestamp < entryTs || timestamp - entryTs > windowMs) {
      return false;
    }

    if (predicate && !predicate(entry)) {
      return false;
    }

    return true;
  });
}

function resolveExpenseAlertBaseline(expenseSamples: number[], incomeSamples: number[]): number | undefined {
  const expenseP90 = calculatePercentile(expenseSamples, 0.9);
  const expenseMedian = calculateMedian(expenseSamples);
  const incomeP75 = calculatePercentile(incomeSamples, 0.75);

  const candidates = [expenseP90, expenseMedian, incomeP75].filter((value): value is number => typeof value === "number" && value > 0);
  if (candidates.length === 0) {
    return undefined;
  }

  return Math.max(...candidates);
}

function resolveIncomeAlertBaseline(incomeSamples: number[]): number | undefined {
  const incomeP90 = calculatePercentile(incomeSamples, 0.9);
  const incomeMedian = calculateMedian(incomeSamples);

  const candidates = [incomeP90, incomeMedian].filter((value): value is number => typeof value === "number" && value > 0);
  if (candidates.length === 0) {
    return undefined;
  }

  return Math.max(...candidates);
}

function calculatePercentile(values: number[], percentile: number): number | undefined {
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sorted[lower];
  }

  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}
