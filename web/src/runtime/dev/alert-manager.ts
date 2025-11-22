import { randomUUID, createHash } from "node:crypto";

import { alertLogger } from "../shared/logger";
import { prisma } from "@/lib/prisma";

import {
  createEmptyMetrics,
  detectAnomalies,
  updateMetrics,
  type AlertMetricsState,
  type AlertRuleId,
  type AlertSeverity,
  type DetectedAlert,
} from "./alert-detector";
import {
  BehaviorProfileCache,
  type BehaviorAssessment,
} from "./behavior-profile";
import type { NormalizedTransaction } from "./transaction-normalizer";

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
  // No longer using file-based storage
  // Metrics stored in-memory only
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

export async function createAlertManager(
  options: AlertManagerOptions = {},
): Promise<TransactionAlertManager> {
  const manager = new MemoryAlertManager(options);
  await manager.initialize();
  return manager;
}

class MemoryAlertManager implements TransactionAlertManager {
  private alerts: AlertRecord[] = [];
  private metrics: AlertMetricsState = createEmptyMetrics();
  private readonly listeners = new Set<AlertListener>();
  private initialized = false;
  private readonly behaviorCache: BehaviorProfileCache;
  private readonly userId: number; // User ID for API calls
  private readonly alertSignatureCache = new Map<string, { timestamp: number; count: number }>(); // Signature-based deduplication
  private readonly ALERT_SUPPRESSION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  constructor(options: AlertManagerOptions) {
    this.behaviorCache = new BehaviorProfileCache({ baseDir: process.cwd() });
    
    // Get user ID from environment (required for API calls)
    const userIdEnv = process.env.DEV_USER_ID;
    if (!userIdEnv) {
      throw new Error("DEV_USER_ID environment variable is required for alert manager");
    }
    this.userId = Number.parseInt(userIdEnv, 10);
    if (!Number.isFinite(this.userId)) {
      throw new Error(`Invalid DEV_USER_ID: ${userIdEnv}`);
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize with empty metrics (in-memory only, no file storage)
    this.metrics = createEmptyMetrics();

    // Load alerts from Prisma
    try {
      const dbAlerts = await prisma.alerts.findMany({
        where: { owner: Number(this.userId) },
        orderBy: { date_created: 'desc' }
      });
      this.alerts = dbAlerts.map(this.convertDbAlertToRecord);
      alertLogger.debug("Loaded alerts from database", { count: this.alerts.length });
    } catch (error) {
      alertLogger.error("Failed to load alerts from database, starting with empty list", { error });
      this.alerts = [];
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
      const now = Date.now();
      
      for (const alert of contextualAlerts) {
        // Generate signature for deduplication
        const signature = this.generateAlertSignature(alert, transaction, timestamp);
        
        // Check if similar alert was recently fired
        if (this.shouldSuppressAlert(signature, now)) {
          alertLogger.info("Suppressed duplicate alert", { 
            rule: alert.rule, 
            signaturePrefix: signature.substring(0, 16) 
          });
          continue;
        }
        
        const record = this.buildAlertRecord(transaction, alert);
        
        // Persist to API instead of local JSON
        try {
          await this.persistAlertToDatabase(record, transaction);
          this.alerts.push(record); // Keep in memory for listAlerts
          events.push(record);
          
          // Record signature after successful persistence
          this.recordAlertSignature(signature, now);
          
          alertLogger.info("Alert persisted to API", { 
            rule: record.rule, 
            severity: record.severity 
          });
        } catch (error) {
          alertLogger.error("Failed to persist alert to API", { error });
          // Still add to memory and notify, but log the error
          this.alerts.push(record);
          events.push(record);
        }
      }
    }

    if (timestamp !== undefined) {
      updateMetrics(this.metrics, transaction, timestamp);
      // Metrics now kept in-memory only (no file persistence)
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
    const now = new Date();
    if (status === "acknowledged" || status === "dismissed") {
      target.acknowledgedAt = now.toISOString();
      if (actor) {
        target.acknowledgedBy = actor;
      } else {
        delete target.acknowledgedBy;
      }
    }

    // Update via Prisma
    try {
      const alertIdNum = Number.parseInt(target.id, 10);
      if (Number.isFinite(alertIdNum)) {
        await prisma.alerts.update({
          where: { id: alertIdNum },
          data: {
            alert_status: status,
            acknowledged_at: status === "acknowledged" || status === "dismissed" ? now : null,
            acknowledged_by: actor || null,
            date_updated: now,
          },
        });
      }
    } catch (error) {
      alertLogger.error("Failed to update alert status via Prisma", { error });
      throw error;
    }

    return target;
  }

  private async persistAlerts(): Promise<void> {
    // Alerts are now persisted to API in evaluateTransaction
    // This method kept for backward compatibility but does nothing
    alertLogger.info("persistAlerts called - using API persistence");
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
        alertLogger.error("Listener failed", { error });
      }
    }
  }

  private async resolveBehaviorAssessment(
    transaction: NormalizedTransaction,
  ): Promise<BehaviorAssessment | null> {
    try {
      return await this.behaviorCache.assess(transaction);
    } catch (error) {
      alertLogger.error("Failed to derive behavior context", { error });
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

  /**
   * Convert database alert to AlertRecord format
   */
  private convertDbAlertToRecord(dbAlert: any): AlertRecord {
    return {
      id: String(dbAlert.id),
      transactionId: dbAlert.transaction_id || "",
      createdAt: dbAlert.date_created?.toISOString() || new Date().toISOString(),
      rule: dbAlert.rule_id as AlertRuleId,
      severity: dbAlert.severity as AlertSeverity,
      confidence: Number(dbAlert.confidence) || 0,
      summary: dbAlert.message,
      details: dbAlert.details || {},
      status: dbAlert.alert_status as AlertStatus,
      acknowledgedAt: dbAlert.acknowledged_at?.toISOString(),
      acknowledgedBy: dbAlert.acknowledged_by,
    };
  }

  /**
   * Persist alert to database via Prisma
   */
  private async persistAlertToDatabase(
    record: AlertRecord,
    transaction: NormalizedTransaction
  ): Promise<void> {
    const threshold = record.details?.threshold;
    const actual = record.details?.actual;
    const deviation = record.details?.deviation;

    await prisma.alerts.create({
      data: {
        status: "Active",
        owner: Number(this.userId),
        transaction_id: transaction.id,
        alert_type: this.mapRuleToType(record.rule),
        severity: record.severity,
        rule_id: record.rule,
        message: record.summary,
        confidence: Number(record.confidence),
        threshold_value: typeof threshold === "number" ? threshold : null,
        actual_value: typeof actual === "number" ? actual : null,
        deviation_percentage: typeof deviation === "number" ? deviation : null,
        category: transaction.category || null,
        merchant: transaction.meta.targetParty || null,
        details: record.details as any || null,
        date_created: new Date(record.createdAt),
        date_updated: new Date(),
      },
    });
  }

  /**
   * Map alert rule ID to alert type for API
   */
  private mapRuleToType(
    rule: AlertRuleId
  ): "anomaly" | "threshold" | "pattern" | "budget" {
    if (rule.includes("anomaly") || rule.includes("unusual")) {
      return "anomaly";
    }
    if (rule.includes("threshold") || rule.includes("limit")) {
      return "threshold";
    }
    if (rule.includes("pattern") || rule.includes("velocity")) {
      return "pattern";
    }
    return "budget";
  }

  /**
   * Generate signature for alert deduplication (includes owner ID)
   */
  private generateAlertSignature(
    alert: DetectedAlert,
    transaction: NormalizedTransaction,
    timestamp: number | undefined,
  ): string {
    const timeWindow = timestamp ? Math.floor(timestamp / this.ALERT_SUPPRESSION_WINDOW_MS) : 0;
    const targetParty = transaction.meta.targetParty?.slice(0, 30).toLowerCase() || 'unknown';
    
    const components = [
      this.userId.toString(), // Isolate alerts per user
      alert.rule,
      targetParty,
      timeWindow.toString(),
    ].join(':');
    
    return createHash('sha256')
      .update(components)
      .digest('hex')
      .slice(0, 16); // 8 bytes
  }

  /**
   * Check if alert should be suppressed based on recent signature
   */
  private shouldSuppressAlert(signature: string, now: number): boolean {
    const cached = this.alertSignatureCache.get(signature);
    
    if (!cached) {
      return false;
    }
    
    // Check if within suppression window
    const age = now - cached.timestamp;
    if (age > this.ALERT_SUPPRESSION_WINDOW_MS) {
      // Expired, remove from cache
      this.alertSignatureCache.delete(signature);
      return false;
    }
    
    return true;
  }

  /**
   * Record alert signature after successful persistence
   */
  private recordAlertSignature(signature: string, timestamp: number): void {
    this.alertSignatureCache.set(signature, {
      timestamp,
      count: (this.alertSignatureCache.get(signature)?.count || 0) + 1,
    });
    
    // Cleanup old entries (keep cache size bounded)
    if (this.alertSignatureCache.size > 1000) {
      const cutoff = timestamp - this.ALERT_SUPPRESSION_WINDOW_MS;
      for (const [sig, data] of this.alertSignatureCache.entries()) {
        if (data.timestamp < cutoff) {
          this.alertSignatureCache.delete(sig);
        }
      }
    }
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
