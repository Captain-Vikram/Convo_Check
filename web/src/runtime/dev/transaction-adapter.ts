/**
 * Transaction Adapter Factory
 * 
 * Consolidates duplicate metadata/transaction builders into a single factory.
 * Provides type-safe conversion between different transaction formats.
 */

import type { NormalizedTransaction } from "./transaction-normalizer";
import type { AnalystMetadata } from "./dev-agent";

export interface HabitTransaction {
  ownerPhone: string;
  transactionId: string;
  datetime: string;
  date: string;
  time: string;
  amount: number;
  currency: string;
  type: "debit" | "credit";
  targetParty: string;
  description: string;
  category: string;
  isFinancial: boolean;
  medium: string;
}

/**
 * Components extracted from a transaction for duplicate key generation
 */
export interface DuplicateKeyComponents {
  direction: string;
  amount: string;
  currency: string;
  eventDate: string;
  eventTime: string;
  description: string;
  targetParty: string;
}

/**
 * Transaction Adapter Factory
 */
export class TransactionAdapter {
  constructor(private transaction: NormalizedTransaction) {}

  /**
   * Convert to Analyst metadata format
   */
  toAnalystMetadata(): AnalystMetadata {
    const metadata: AnalystMetadata = {
      transactionId: this.transaction.id,
      recordedAt: this.transaction.recordedAt,
      amount: this.transaction.amount,
      currency: this.transaction.currency,
      direction: this.transaction.direction,
      category: this.transaction.category,
      flavor: this.transaction.flavor,
      tags: this.transaction.tags,
      description: this.transaction.description,
      eventDate: this.transaction.eventDate,
    };

    if (this.transaction.eventTime) {
      metadata.eventTime = this.transaction.eventTime;
    }

    return metadata;
  }

  /**
   * Convert to Habit Tracker transaction format
   */
  toHabitTransaction(ownerPhone?: string): HabitTransaction {
    const datetime = this.transaction.eventTime
      ? `${this.transaction.eventDate}T${this.transaction.eventTime}`
      : `${this.transaction.eventDate}T00:00:00`;

    return {
      ownerPhone: ownerPhone || this.transaction.currency, // Fallback for legacy behavior
      transactionId: this.transaction.id,
      datetime,
      date: this.transaction.eventDate,
      time: this.transaction.eventTime || "00:00:00",
      amount: this.transaction.amount,
      currency: this.transaction.currency,
      type: this.transaction.direction === "income" ? "credit" : "debit",
      targetParty: this.transaction.meta.targetParty || "",
      description: this.transaction.description,
      category: this.transaction.category,
      isFinancial: true,
      medium: this.transaction.meta.medium || "",
    };
  }

  /**
   * Extract duplicate detection key components
   */
  getDuplicateKeyComponents(): DuplicateKeyComponents {
    return {
      description: this.transaction.description.trim().toLowerCase(),
      targetParty: this.transaction.meta.targetParty?.trim().toLowerCase() ?? "",
      currency: this.transaction.currency.trim().toUpperCase(),
      direction: this.transaction.direction,
      amount: Number.isFinite(this.transaction.amount)
        ? this.transaction.amount.toFixed(2)
        : "0.00",
      eventDate: this.transaction.eventDate,
      eventTime: this.transaction.eventTime ?? "",
    };
  }

  /**
   * Get original normalized transaction
   */
  getOriginal(): NormalizedTransaction {
    return this.transaction;
  }
}

/**
 * Factory function to create adapter
 */
export function createTransactionAdapter(transaction: NormalizedTransaction): TransactionAdapter {
  return new TransactionAdapter(transaction);
}
