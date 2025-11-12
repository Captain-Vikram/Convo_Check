/**
 * ToolRegistry - Centralized tool management
 * Eliminates duplicate tool imports and provides singleton access
 */

import {
  createLogCashTransactionTool,
  logCashTransactionToolDefinition,
  type LogCashTransactionExecutor,
  type LogCashTransactionPayload,
} from "../../tools/log-cash-transaction.js";
import {
  createQuerySpendingSummaryTool,
  querySpendingSummaryToolDefinition,
  type QuerySpendingSummaryExecutor,
  type SpendingSummaryResult,
} from "../../tools/query-spending-summary.js";
import {
  createWebSearchTool,
  webSearchToolDefinition,
  type WebSearchExecutor,
} from "../../tools/web-search.js";

export type ToolName = "log_cash_transaction" | "query_spending_summary" | "get_factual_answer";

export interface ToolExecutors {
  logTransaction: LogCashTransactionExecutor;
  querySpending: QuerySpendingSummaryExecutor;
  webSearch: WebSearchExecutor;
}

/**
 * Singleton ToolRegistry for managing and accessing agent tools
 */
class ToolRegistryImpl {
  private static instance: ToolRegistryImpl;
  private tools: Map<ToolName, any> = new Map();
  private executors?: ToolExecutors;

  private constructor() {}

  static getInstance(): ToolRegistryImpl {
    if (!ToolRegistryImpl.instance) {
      ToolRegistryImpl.instance = new ToolRegistryImpl();
    }
    return ToolRegistryImpl.instance;
  }

  /**
   * Initialize tools with executors
   */
  initialize(executors: ToolExecutors): void {
    this.executors = executors;

    // Register tools
    this.tools.set("log_cash_transaction", createLogCashTransactionTool(executors.logTransaction));
    this.tools.set(
      "query_spending_summary",
      createQuerySpendingSummaryTool(executors.querySpending),
    );
    this.tools.set("get_factual_answer", createWebSearchTool(executors.webSearch));
  }

  /**
   * Get a specific tool by name
   */
  getTool(name: ToolName): any | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all tools as a record for AI SDK
   */
  getAllTools(): Record<string, any> {
    const toolsRecord: Record<string, any> = {};
    for (const [name, tool] of this.tools.entries()) {
      toolsRecord[name] = tool;
    }
    return toolsRecord;
  }

  /**
   * Get tools for specific agent
   */
  getToolsForAgent(agentId: "agent1" | "agent2" | "agent3" | "agent4"): Record<string, any> {
    switch (agentId) {
      case "agent1": // Chatbot (Mill)
        return {
          log_cash_transaction: this.tools.get("log_cash_transaction")!,
          query_spending_summary: this.tools.get("query_spending_summary")!,
          get_factual_answer: this.tools.get("get_factual_answer")!,
        };
      case "agent2": // Dev (Accountant)
        return {}; // Dev doesn't use tools directly
      case "agent3": // Param (Analyst)
        return {}; // Param doesn't use tools directly
      case "agent4": // Chatur (Coach)
        return {
          query_spending_summary: this.tools.get("query_spending_summary")!,
        };
      default:
        return {};
    }
  }

  /**
   * Get tool definitions (for documentation/introspection)
   */
  getToolDefinitions(): Record<ToolName, any> {
    return {
      log_cash_transaction: logCashTransactionToolDefinition,
      query_spending_summary: querySpendingSummaryToolDefinition,
      get_factual_answer: webSearchToolDefinition,
    };
  }

  /**
   * Check if tools are initialized
   */
  isInitialized(): boolean {
    return this.executors !== undefined && this.tools.size > 0;
  }
}

// Export singleton instance
export const ToolRegistry = ToolRegistryImpl.getInstance();

// Export types
export type {
  LogCashTransactionPayload,
  LogCashTransactionExecutor,
  SpendingSummaryResult,
  QuerySpendingSummaryExecutor,
  WebSearchExecutor,
};
