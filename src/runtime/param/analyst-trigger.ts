/**
 * Analyst Trigger Utilities
 * 
 * Provides functions to trigger analyst runs from other agents (e.g., dev-agent)
 * when new transactions are created. Implements debouncing to avoid excessive runs.
 */

import { logger } from "../shared/logger.js";

let pendingAnalystRun: NodeJS.Timeout | null = null;
let pendingTransactionCount = 0;

const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const MIN_TRANSACTIONS_FOR_TRIGGER = 3; // Minimum new transactions to trigger analysis

/**
 * Schedule an analyst run (debounced)
 * 
 * This function accumulates transaction events and triggers an analyst run
 * after a debounce period or when a threshold is reached.
 * 
 * @param options - Configuration options
 */
export function scheduleAnalystRun(options: {
  immediate?: boolean;
  reanalyzeAll?: boolean;
} = {}): void {
  pendingTransactionCount++;

  logger.info("analyst-trigger", "Transaction added to analyst queue", {
    pendingCount: pendingTransactionCount,
    debounceMs: DEBOUNCE_MS,
  });

  // Clear existing timeout
  if (pendingAnalystRun) {
    clearTimeout(pendingAnalystRun);
  }

  // Immediate trigger (bypasses debounce)
  if (options.immediate) {
    triggerAnalystRun(options.reanalyzeAll || false);
    return;
  }

  // Trigger immediately if threshold reached
  if (pendingTransactionCount >= MIN_TRANSACTIONS_FOR_TRIGGER) {
    logger.info("analyst-trigger", "Transaction threshold reached, triggering analyst immediately", {
      pendingCount: pendingTransactionCount,
      threshold: MIN_TRANSACTIONS_FOR_TRIGGER,
    });
    triggerAnalystRun(options.reanalyzeAll || false);
    return;
  }

  // Schedule debounced run
  pendingAnalystRun = setTimeout(() => {
    triggerAnalystRun(options.reanalyzeAll || false);
  }, DEBOUNCE_MS);

  logger.info("analyst-trigger", "Analyst run scheduled", {
    pendingCount: pendingTransactionCount,
    triggerIn: `${DEBOUNCE_MS / 1000}s`,
  });
}

/**
 * Trigger analyst run via API call
 * 
 * @param reanalyzeAll - Whether to force full reanalysis
 */
async function triggerAnalystRun(reanalyzeAll: boolean): Promise<void> {
  const count = pendingTransactionCount;
  pendingTransactionCount = 0;
  pendingAnalystRun = null;

  logger.info("analyst-trigger", "Triggering analyst run", {
    transactionCount: count,
    reanalyzeAll,
  });

  try {
    const serviceToken = process.env.SERVICE_API_TOKEN;
    const baseUrl = process.env.MILL_API_BASE_URL ?? "http://localhost:3000";
    const endpoint = `${baseUrl}/api/analyst/auto-run${reanalyzeAll ? "?reanalyzeAll=true" : ""}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {}),
      },
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "<no body>");
      throw new Error(`Analyst API trigger failed (${response.status}): ${errorBody}`);
    }

    const result = await response.json();

    if (result && typeof result === "object" && "success" in result && result.success) {
      logger.info("analyst-trigger", "Analyst run completed successfully", {
        message: (result as any).result?.message,
        analyzedTransactions: (result as any).result?.analyzedTransactions,
        insightsGenerated: (result as any).result?.insightsGenerated,
      });
    } else {
      logger.warn("analyst-trigger", "Analyst run completed with non-success status", {
        status: (result as any).result?.status,
        message: (result as any).result?.message,
      });
    }
  } catch (error) {
    logger.error("analyst-trigger", "Failed to trigger analyst run", error);
  }
}

/**
 * Cancel any pending analyst run
 */
export function cancelPendingAnalystRun(): void {
  if (pendingAnalystRun) {
    clearTimeout(pendingAnalystRun);
    pendingAnalystRun = null;
    logger.info("analyst-trigger", "Cancelled pending analyst run", {
      pendingCount: pendingTransactionCount,
    });
    pendingTransactionCount = 0;
  }
}
