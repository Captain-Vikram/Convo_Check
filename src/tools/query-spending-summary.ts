import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolDefinition } from "../agents/types.js";

export const querySpendingSummaryToolDefinition: ToolDefinition = {
  name: "query_spending_summary",
  description:
    "Retrieve comprehensive financial data by coordinating with Dev (transactions), Param (habit insights), and Coach (guidance). Returns: totalExpense, totalIncome, netBalance, transactionCount, recentTransactions (last 10 with id/direction/amount/description/category/eventDate), topCategories (top 5 by spend), paramInsights (habit analysis from Param), and coachAdvice (latest guidance from Coach). Use this to answer questions about spending history, transaction details, financial patterns, or to show what data is available.",
  parameters: [],
};

export interface SpendingSummaryResult {
  totalExpense: number;
  totalIncome: number;
  netBalance: number;
  transactionCount: number;
  recentTransactions: Array<{
    id: string;
    direction: string;
    amount: number;
    description: string;
    category: string;
    eventDate?: string;
  }>;
  topCategories: Array<{
    category: string;
    totalSpent: number;
    count: number;
  }>;
  paramInsights: string[];
  coachAdvice: string | null;
}

export type QuerySpendingSummaryExecutor = () => Promise<SpendingSummaryResult>;

export function createQuerySpendingSummaryTool(executor: QuerySpendingSummaryExecutor) {
  const emptySchema = z.object({});

  const createTool = tool as unknown as (options: {
    name: string;
    description: string;
    parameters: typeof emptySchema;
    execute: () => Promise<SpendingSummaryResult>;
  }) => Tool;

  return createTool({
    name: querySpendingSummaryToolDefinition.name,
    description: querySpendingSummaryToolDefinition.description,
    parameters: emptySchema,
    execute: async () => {
      return executor();
    },
  });
}
