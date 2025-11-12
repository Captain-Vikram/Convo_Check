import { createHash } from "node:crypto";

import type { DevPipelineResult } from "./dev-agent.js";
import type { SmsMessage } from "./dev-sms-agent.js";
import type { NormalizedTransaction } from "./transaction-normalizer.js";

export interface SmsLogOptions {
  // No file-based options needed - uses in-memory tracking
}

export interface SmsLog {
  record(message: SmsMessage, result: DevPipelineResult): Promise<void>;
}

/**
 * Creates an in-memory SMS log for tracking processed messages and preventing duplicates.
 * No longer writes to CSV files - uses in-memory Set for fingerprint tracking.
 */
export async function createSmsLog(options: SmsLogOptions = {}): Promise<SmsLog> {
  const knownFingerprints = new Set<string>();

  async function record(message: SmsMessage, result: DevPipelineResult): Promise<void> {
    if (result.status !== "logged") {
      return;
    }

    const normalized = result.normalized;
    const fingerprint = buildFingerprint(message);
    
    if (knownFingerprints.has(fingerprint)) {
      console.debug("[sms-log] Duplicate fingerprint detected", { fingerprint, sender: message.sender });
      return;
    }

    knownFingerprints.add(fingerprint);
    
    // Log to console for auditing
    console.log("[sms-log] Recorded SMS transaction", {
      fingerprint,
      sender: message.sender,
      transactionId: normalized.id,
      amount: normalized.amount,
      currency: normalized.currency,
      category: normalized.category,
      recordedAt: new Date().toISOString(),
    });
  }

  return {
    record,
  };
}

function buildFingerprint(message: SmsMessage): string {
  const hash = createHash("sha256");
  hash.update(message.sender);
  hash.update("|");
  hash.update(message.message);

  if (message.timestamp) {
    hash.update("|ts:");
    hash.update(message.timestamp);
  }

  if (message.date) {
    hash.update("|date:");
    hash.update(message.date);
  }

  if (message.time) {
    hash.update("|time:");
    hash.update(message.time);
  }

  return hash.digest("hex");
}
