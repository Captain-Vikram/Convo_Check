import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

import {
  createEmptyMetrics,
  detectAnomalies,
  updateMetrics,
  type AlertMetricsState,
  type AlertRuleId,
  type AlertSeverity,
  type DetectedAlert,
} from "./alert-detector.js";
import {
  BehaviorProfileCache,
  type BehaviorAssessment,
} from "./behavior-profile.js";
import type { NormalizedTransaction } from "./transaction-normalizer.js";

export type AlertStatus = "open" | "acknowledged" | "dismissed";

export interface AlertRecord {
  id: string;
  transactionId: string;
  createdAt: string;
  rule: AlertRuleId;
  severity: AlertSeverity;
  confidence: number;
  summary: string;
  details?: Record<string, unknown>;
  status: AlertStatus;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
}

export interface AlertListFilter {
  status?: AlertStatus;
  limit?: number;
  since?: string;
}

export interface AlertManagerOptions {
  baseDir?: string;
  alertsFileName?: string;
  metricsFileName?: string;
  habitsFileName?: string;
}

export interface TransactionAlertManager {
  evaluateTransaction(transaction: NormalizedTransaction): Promise<AlertRecord[]>;
  listAlerts(filter?: AlertListFilter): Promise<AlertRecord[]>;
  updateAlertStatus(
    id: string,
    status: AlertStatus,
    actor?: string,
  ): Promise<AlertRecord | undefined>;
  subscribe(listener: AlertListener): () => void;
}

type AlertListener = (records: AlertRecord[]) => Promise<void> | void;

interface PersistedState {
  alerts: AlertRecord[];
  metrics: AlertMetricsState;
}

const DEFAULT_ALERTS_FILE = "alerts.json";
const DEFAULT_METRICS_FILE = "alert-metrics.json";

export async function createAlertManager(
  options: AlertManagerOptions = {},
): Promise<TransactionAlertManager> {
  const manager = new FileAlertManager(options);
  await manager.initialize();
  return manager;
}

class FileAlertManager implements TransactionAlertManager {
  private readonly alertsFile: string;
  private readonly metricsFile: string;
  private alerts: AlertRecord[] = [];
  private metrics: AlertMetricsState = createEmptyMetrics();
  private readonly listeners = new Set<AlertListener>();
  private initialized = false;
  private readonly behaviorCache: BehaviorProfileCache;

  constructor(options: AlertManagerOptions) {
    const baseDir = options.baseDir ?? join(process.cwd(), "data");
    this.alertsFile = join(baseDir, options.alertsFileName ?? DEFAULT_ALERTS_FILE);
    this.metricsFile = join(baseDir, options.metricsFileName ?? DEFAULT_METRICS_FILE);
    const behaviorOptions = options.habitsFileName
      ? { baseDir, habitsFileName: options.habitsFileName }
      : { baseDir };
    this.behaviorCache = new BehaviorProfileCache(behaviorOptions);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.ensureFile(this.alertsFile, "[]");
    await this.ensureFile(this.metricsFile, JSON.stringify(createEmptyMetrics(), null, 2));

    const [alertsContent, metricsContent] = await Promise.all([
      readFile(this.alertsFile, "utf8"),
      readFile(this.metricsFile, "utf8"),
    ]);

    try {
      const parsedAlerts = JSON.parse(alertsContent) as unknown;
      if (Array.isArray(parsedAlerts)) {
        this.alerts = parsedAlerts as AlertRecord[];
      }
    } catch (error) {
      console.error("[alert-manager] Failed to parse alerts file", error);
      this.alerts = [];
    }

    try {
      const parsedMetrics = JSON.parse(metricsContent) as unknown;
      this.metrics = normalizeMetrics(parsedMetrics);
    } catch (error) {
      console.error("[alert-manager] Failed to parse metrics file", error);
      this.metrics = createEmptyMetrics();
    }

    this.initialized = true;
  }

  subscribe(listener: AlertListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async evaluateTransaction(transaction: NormalizedTransaction): Promise<AlertRecord[]> {
    const detection = detectAnomalies(transaction, this.metrics);
    const timestamp = detection.timestamp ?? resolveTimestamp(transaction);
    const behaviorAssessment = detection.alerts.length > 0
      ? await this.resolveBehaviorAssessment(transaction)
      : null;
    const contextualAlerts = detection.alerts.length > 0
      ? detection.alerts.map((alert) => this.contextualizeAlert(alert, behaviorAssessment))
      : [];
    const events: AlertRecord[] = [];

    if (contextualAlerts.length > 0) {
      for (const alert of contextualAlerts) {
        const record = this.buildAlertRecord(transaction, alert);
        this.alerts.push(record);
        events.push(record);
      }

      await this.persistAlerts();
    }

    if (timestamp !== undefined) {
      updateMetrics(this.metrics, transaction, timestamp);
      await this.persistMetrics();
    }

    if (events.length > 0) {
      await this.notify(events);
    }

    return events;
  }

  async listAlerts(filter: AlertListFilter = {}): Promise<AlertRecord[]> {
    const source = [...this.alerts].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    let filtered = source;
    if (filter.status) {
      filtered = filtered.filter((alert) => alert.status === filter.status);
    }

    if (filter.since) {
      const sinceTs = Date.parse(filter.since);
      if (!Number.isNaN(sinceTs)) {
        filtered = filtered.filter((alert) => Date.parse(alert.createdAt) >= sinceTs);
      }
    }

    if (filter.limit !== undefined && filter.limit >= 0) {
      filtered = filtered.slice(0, filter.limit);
    }

    return filtered;
  }

  async updateAlertStatus(
    id: string,
    status: AlertStatus,
    actor?: string,
  ): Promise<AlertRecord | undefined> {
    const target = this.alerts.find((alert) => alert.id === id);
    if (!target) {
      return undefined;
    }

    target.status = status;
    const now = new Date().toISOString();
    if (status === "acknowledged" || status === "dismissed") {
      target.acknowledgedAt = now;
      if (actor) {
        target.acknowledgedBy = actor;
      } else {
        delete target.acknowledgedBy;
      }
    }

    await this.persistAlerts();
    return target;
  }

  private async persistAlerts(): Promise<void> {
    await this.writeJson(this.alertsFile, this.alerts);
  }

  private async persistMetrics(): Promise<void> {
    await this.writeJson(this.metricsFile, this.metrics);
  }

  private buildAlertRecord(
    transaction: NormalizedTransaction,
    alert: DetectedAlert,
  ): AlertRecord {
    return {
      id: randomUUID(),
      transactionId: transaction.id,
      createdAt: new Date().toISOString(),
      rule: alert.rule,
      severity: alert.severity,
      confidence: Number(alert.confidence.toFixed(2)),
      summary: alert.summary,
      details: {
        ...alert.details,
        transaction: {
          amount: transaction.amount,
          currency: transaction.currency,
          direction: transaction.direction,
          targetParty: transaction.meta.targetParty,
        },
      },
      status: "open",
    };
  }

  private async notify(alerts: AlertRecord[]): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(alerts);
      } catch (error) {
        console.error("[alert-manager] Listener failed", error);
      }
    }
  }

  private async ensureFile(filePath: string, defaultContents: string): Promise<void> {
    try {
      await access(filePath, constants.F_OK);
    } catch {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${defaultContents}\n`, "utf8");
    }
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  private async resolveBehaviorAssessment(
    transaction: NormalizedTransaction,
  ): Promise<BehaviorAssessment | null> {
    try {
      return await this.behaviorCache.assess(transaction);
    } catch (error) {
      console.error("[alert-manager] Failed to derive behavior context", error);
      return null;
    }
  }

  private contextualizeAlert(
    alert: DetectedAlert,
    behavior: BehaviorAssessment | null,
  ): DetectedAlert {
    const details: Record<string, unknown> = {
      ...(alert.details ?? {}),
    };

    if (!behavior) {
      details.behaviorContext = { matches: [] };
      return {
        ...alert,
        details,
      };
    }

    const baseContext = {
      matches: behavior.matches,
      bestMatch: behavior.bestMatch,
    };
    details.behaviorContext = baseContext;

    const best = behavior.bestMatch;
    if (!best) {
      return {
        ...alert,
        summary: `${alert.summary} Behavioral context not yet established.`,
        details,
      };
    }

    let severity = alert.severity;
    let confidence = alert.confidence;
    let summarySuffix: string;

    switch (best.classification) {
      case "expected":
        severity = downgradeSeverity(severity);
        confidence = clampConfidence(confidence - 0.2);
        summarySuffix = `Marked as expected behavior — ${best.message}`;
        break;
      case "borderline":
        confidence = clampConfidence(confidence - 0.05);
        summarySuffix = `Behavior context: ${best.message}`;
        break;
      case "unusual":
        confidence = clampConfidence(confidence + 0.05);
        summarySuffix = `Behavior context: ${best.message}`;
        break;
      case "flagged":
        severity = upgradeSeverity(severity);
        confidence = clampConfidence(confidence + 0.15);
        summarySuffix = `Behavior context escalates risk — ${best.message}`;
        break;
      default:
        summarySuffix = `Behavior context limited — ${best.message}`;
        break;
    }

    const summary = `${alert.summary} ${summarySuffix}`.trim();

    return {
      ...alert,
      severity,
      confidence,
      summary,
      details,
    };
  }
}

function downgradeSeverity(value: AlertSeverity): AlertSeverity {
  if (value === "high") {
    return "medium";
  }
  return "low";
}

function upgradeSeverity(value: AlertSeverity): AlertSeverity {
  if (value === "low") {
    return "medium";
  }
  return "high";
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  const clamped = Math.min(0.99, Math.max(0.05, value));
  return Number.parseFloat(clamped.toFixed(2));
}

function normalizeMetrics(candidate: unknown): AlertMetricsState {
  if (!candidate || typeof candidate !== "object") {
    return createEmptyMetrics();
  }

  const metrics = candidate as AlertMetricsState;
  const recentTransactions = Array.isArray(metrics.recentTransactions)
    ? metrics.recentTransactions.filter((entry) => typeof entry === "object" && entry !== null)
    : [];

  const incomeSamples = Array.isArray(metrics.incomeSamples)
    ? metrics.incomeSamples.filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
      )
    : [];

  const expenseSamples = Array.isArray(metrics.expenseSamples)
    ? metrics.expenseSamples.filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
      )
    : [];

  return {
    recentTransactions: recentTransactions.map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : randomUUID(),
      timestamp:
        typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp))
          ? entry.timestamp
          : new Date().toISOString(),
      amount: typeof entry.amount === "number" && Number.isFinite(entry.amount) ? entry.amount : 0,
      direction: entry.direction === "income" ? "income" : "expense",
      ...(entry.targetParty ? { targetParty: String(entry.targetParty) } : {}),
    })),
    incomeSamples,
    expenseSamples,
  };
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
