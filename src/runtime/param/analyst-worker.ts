/**
 * Background Worker for Automatic Transaction Analysis
 * 
 * This worker periodically checks for new transactions and runs the analyst agent
 * to generate insights. It implements the hybrid incremental + periodic reanalysis strategy.
 * 
 * Usage:
 * - Incremental: `npx tsx src/runtime/param/analyst-worker.ts`
 * - Full reanalysis: `npx tsx src/runtime/param/analyst-worker.ts --reanalyze-all`
 * - Continuous mode: `npx tsx src/runtime/param/analyst-worker.ts --watch`
 */

import { logger } from "../shared/logger.js";
import { runAnalyst, type RunAnalystOptions, type AnalystRunResult } from "./analyst-agent.js";

interface WorkerOptions {
  /** Run in continuous watch mode (checks every interval) */
  watch?: boolean;
  /** Interval in milliseconds for watch mode (default: 6 hours) */
  intervalMs?: number;
  /** Force full reanalysis of all transactions */
  reanalyzeAll?: boolean;
  /** Run once and exit */
  once?: boolean;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MIN_INTERVAL_MS = 60 * 1000; // 1 minute minimum

export class AnalystWorker {
  private intervalId?: NodeJS.Timeout | null;
  private isRunning = false;
  private runCount = 0;

  constructor(private options: WorkerOptions = {}) {
    this.options.intervalMs = Math.max(
      this.options.intervalMs || DEFAULT_INTERVAL_MS,
      MIN_INTERVAL_MS,
    );
  }

  async start(): Promise<void> {
    logger.info("analyst-worker", "Starting analyst worker", {
      watch: this.options.watch,
      intervalMs: this.options.intervalMs,
      reanalyzeAll: this.options.reanalyzeAll,
    });

    // Run immediately on start
    await this.runAnalysis();

    if (this.options.watch) {
      this.startWatchMode();
    } else if (!this.options.once) {
      logger.info("analyst-worker", "Single run completed. Use --watch for continuous mode.");
      process.exit(0);
    }
  }

  private startWatchMode(): void {
    logger.info("analyst-worker", `Starting watch mode (interval: ${this.options.intervalMs}ms)`);

    this.intervalId = setInterval(async () => {
      await this.runAnalysis();
    }, this.options.intervalMs);

    // Keep process alive
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
  }

  private async runAnalysis(): Promise<void> {
    if (this.isRunning) {
      logger.warn("analyst-worker", "Analysis already running, skipping this cycle");
      return;
    }

    this.isRunning = true;
    this.runCount++;

    const startTime = Date.now();
    logger.info("analyst-worker", `Starting analysis run #${this.runCount}`);

    try {
      const runOptions: RunAnalystOptions = {
        reanalyzeAll: this.options.reanalyzeAll || false,
      };

      const result: AnalystRunResult = await runAnalyst(runOptions);

      const duration = Date.now() - startTime;

      logger.info("analyst-worker", `Analysis run #${this.runCount} completed`, {
        status: result.status,
        duration: `${(duration / 1000).toFixed(2)}s`,
        totalTransactions: result.totalTransactions,
        analyzedTransactions: result.analyzedTransactions,
        insightsGenerated: result.insightsGenerated,
        message: result.message,
      });

      if (result.status === "error" && result.error) {
        logger.error("analyst-worker", `Analysis run #${this.runCount} failed`, result.error);
      }
    } catch (error) {
      logger.error("analyst-worker", `Analysis run #${this.runCount} threw exception`, error);
    } finally {
      this.isRunning = false;
    }
  }

  stop(): void {
    logger.info("analyst-worker", "Stopping analyst worker", { runCount: this.runCount });

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    process.exit(0);
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const watch = args.includes("--watch") || args.includes("-w");
  const reanalyzeAll = args.includes("--reanalyze-all") || args.includes("-r");
  const once = args.includes("--once");

  const intervalArg = args.find(arg => arg.startsWith("--interval="));
  let intervalMs: number | undefined;
  if (intervalArg) {
    const intervalValue = intervalArg.split("=")[1];
    if (intervalValue) {
      intervalMs = parseInt(intervalValue, 10) * 60 * 1000; // convert minutes to ms
    }
  }

  const worker = new AnalystWorker({
    watch,
    reanalyzeAll,
    once,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
  });

  worker.start().catch((error) => {
    logger.error("analyst-worker", "Worker failed to start", error);
    process.exit(1);
  });
}
