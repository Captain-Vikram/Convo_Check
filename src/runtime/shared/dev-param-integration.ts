/**
 * Dev-Param Integration
 * 
 * Connects Dev agent's transaction logging to Param's habit tracking.
 * Automatically triggers habit analysis when new transactions are logged.
 */

import type { DevAgentEnvironment, DevPipelineResult } from "../dev/dev-agent.js";
import { analyzeTransactionHabit, type Transaction } from "../param/habit-tracker.js";

export interface DevParamIntegrationOptions {
  devEnvironment: DevAgentEnvironment;
  habitTrackerOptions?: {
    baseDir?: string;
    lookbackCount?: number;
    model?: string;
  };
  onHabitAnalyzed?: (result: {
    transaction: Transaction;
    habitId: string;
    snapshotId: string;
  }) => void | Promise<void>;
}

/**
 * Enables automatic habit tracking when transactions are logged
 */
export async function enableDevParamIntegration(
  options: DevParamIntegrationOptions,
): Promise<() => Promise<void>> {
  const { devEnvironment, habitTrackerOptions, onHabitAnalyzed } = options;

  console.log("🔗 Enabling Dev-Param integration...");
  console.log("   Dev will automatically trigger Param for habit analysis");

  // Monitor new transactions
  const stopMonitor = await devEnvironment.startCsvMonitor(async (records) => {
    console.log(`📊 Processing ${records.length} new transaction(s) for habit analysis...`);

    for (const record of records) {
      try {
        // Convert NormalizedTransaction to Transaction format
        const transaction: Transaction = {
          ownerPhone: record.meta.source || "",
          transactionId: record.id,
          datetime: record.eventTime 
            ? `${record.eventDate}T${record.eventTime}`
            : `${record.eventDate}T00:00:00`,
          date: record.eventDate,
          time: record.eventTime || "00:00:00",
          amount: record.amount,
          currency: record.currency,
          type: record.direction,
          targetParty: record.meta.targetParty || "",
          description: record.description,
          category: record.category,
          isFinancial: true,
          medium: record.meta.medium || "",
        };

        // Analyze habit
        const { habitEntry, snapshot } = await analyzeTransactionHabit(
          transaction,
          habitTrackerOptions || {},
        );

        console.log(`   ✓ Habit analyzed: ${habitEntry.habitType} (${habitEntry.frequency})`);

        // Notify callback
        if (onHabitAnalyzed) {
          await onHabitAnalyzed({
            transaction,
            habitId: habitEntry.habitId,
            snapshotId: snapshot.snapshotId,
          });
        }
      } catch (error) {
        console.error(`   ✗ Failed to analyze habit for ${record.id}:`, error);
      }
    }
  });

  console.log("✅ Dev-Param integration active\n");

  return stopMonitor;
}

/**
 * Manually triggers habit analysis for a transaction result
 */
export async function triggerHabitAnalysisForTransaction(
  result: DevPipelineResult,
  options?: {
    baseDir?: string;
    lookbackCount?: number;
    model?: string;
  },
): Promise<{ habitId: string; snapshotId: string } | null> {
  if (result.status !== "logged") {
    console.log(`⚠️  Skipping habit analysis - transaction not logged (status: ${result.status})`);
    return null;
  }

  const transaction: Transaction = {
    ownerPhone: result.normalized.meta.source || "",
    transactionId: result.normalized.id,
    datetime: result.normalized.eventTime
      ? `${result.normalized.eventDate}T${result.normalized.eventTime}`
      : `${result.normalized.eventDate}T00:00:00`,
    date: result.normalized.eventDate,
    time: result.normalized.eventTime || "00:00:00",
    amount: result.normalized.amount,
    currency: result.normalized.currency,
    type: result.normalized.direction,
    targetParty: result.normalized.meta.targetParty || "",
    description: result.normalized.description,
    category: result.normalized.category,
    isFinancial: true,
    medium: result.normalized.meta.medium || "",
  };

  try {
    const { habitEntry, snapshot } = await analyzeTransactionHabit(transaction, options || {});

    console.log(`✅ Habit tracked: ${habitEntry.habitType} - ${habitEntry.spendingPattern}`);

    return {
      habitId: habitEntry.habitId,
      snapshotId: snapshot.snapshotId,
    };
  } catch (error) {
    console.error("❌ Habit analysis failed:", error);
    return null;
  }
}
