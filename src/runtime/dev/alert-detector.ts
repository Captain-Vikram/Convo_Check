import type { NormalizedTransaction } from "./transaction-normalizer.js";

export type AlertRuleId = "rapid_burst" | "repeat_payee" | "large_withdrawal";
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
}

export interface DetectedAlert {
  rule: AlertRuleId;
  severity: AlertSeverity;
  confidence: number;
  summary: string;
  details?: Record<string, unknown>;
}

const TEN_MINUTES_MS = 10 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const MAX_RECENT_TRANSACTIONS = 100;
const MAX_INCOME_SAMPLES = 24;
const LARGE_WITHDRAWAL_FACTOR = 0.6;

export function createEmptyMetrics(): AlertMetricsState {
  return {
    recentTransactions: [],
    incomeSamples: [],
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

  const windowTransactions = metrics.recentTransactions.filter((entry) => {
    const entryTs = Date.parse(entry.timestamp);
    if (Number.isNaN(entryTs)) {
      return false;
    }
    return timestamp - entryTs <= TEN_MINUTES_MS && timestamp >= entryTs;
  });

  const burstCount = windowTransactions.filter((entry) => entry.direction === transaction.direction).length + 1;

  if (burstCount >= 3) {
    const totalAmount = windowTransactions
      .filter((entry) => entry.direction === transaction.direction)
      .reduce((sum, entry) => sum + entry.amount, transaction.amount);

    alerts.push({
      rule: "rapid_burst",
      severity: burstCount >= 4 ? "high" : "medium",
      confidence: Math.min(0.9, 0.5 + burstCount * 0.1),
      summary: `${formatCurrency(transaction.currency, totalAmount)} across ${burstCount} ${
        transaction.direction === "income" ? "credits" : "debits"
      } within 10 minutes. Latest: ${formatCurrency(transaction.currency, transaction.amount)}.`,
      details: {
        burstCount,
        windowMinutes: 10,
        totalAmount,
      },
    });
  }

  if (normalizedParty && transaction.direction === "expense") {
    const repeatWindow = metrics.recentTransactions.filter((entry) => {
      const entryTs = Date.parse(entry.timestamp);
      if (Number.isNaN(entryTs)) {
        return false;
      }
      if (entry.direction !== "expense") {
        return false;
      }
      if (!entry.targetParty) {
        return false;
      }
      return (
        timestamp - entryTs <= FIFTEEN_MINUTES_MS &&
        timestamp >= entryTs &&
        entry.targetParty.trim().toLowerCase() === normalizedParty
      );
    });

    if (repeatWindow.length >= 2 || (repeatWindow.length === 1 && transaction.amount >= 2000)) {
      const repeatCount = repeatWindow.length + 1;
      const combined = repeatWindow.reduce((sum, entry) => sum + entry.amount, transaction.amount);

      alerts.push({
        rule: "repeat_payee",
        severity: transaction.amount >= 5000 || combined >= 8000 ? "high" : "medium",
        confidence: Math.min(0.95, 0.6 + repeatCount * 0.1),
        summary: `${repeatCount} quick payments to ${transaction.meta.targetParty} totaling ${formatCurrency(
          transaction.currency,
          combined,
        )} in 15 minutes.`,
        details: {
          repeatCount,
          combined,
          target: transaction.meta.targetParty,
        },
      });
    }
  }

  if (transaction.direction === "expense" && metrics.incomeSamples.length > 0) {
    const medianIncome = calculateMedian(metrics.incomeSamples);
    if (medianIncome > 0) {
      const threshold = medianIncome * LARGE_WITHDRAWAL_FACTOR;
      if (transaction.amount >= threshold) {
        alerts.push({
          rule: "large_withdrawal",
          severity: transaction.amount >= medianIncome ? "high" : "medium",
          confidence: Math.min(0.98, transaction.amount / threshold),
          summary: `Debit of ${formatCurrency(transaction.currency, transaction.amount)} exceeds ${Math.round(
            LARGE_WITHDRAWAL_FACTOR * 100,
          )}% of median weekly income ${formatCurrency(transaction.currency, medianIncome)}.`,
          details: {
            medianIncome,
            threshold,
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
