import { tool } from "ai";
import { z } from "zod";

import type { ToolDefinition } from "../agents/types.js";
import type { Tool } from "ai";

export interface LogCashTransactionPayload {
  amount: number;
  description: string;
  category_suggestion: string;
  direction: "expense" | "income";
  raw_text: string;
}

export type LogCashTransactionExecutor = (
  payload: LogCashTransactionPayload,
) => Promise<void> | void;

export const logCashTransactionToolDefinition: ToolDefinition = {
  name: "log_cash_transaction",
  description:
    "Persist a user-reported financial transaction using structured fields extracted from natural language input.",
  parameters: [
    {
      name: "amount",
      description: "The numeric value of the transaction in the user's currency context.",
      type: "number",
      required: true,
    },
    {
      name: "description",
      description: "Short free-form text describing what the transaction was for.",
      type: "string",
      required: true,
    },
    {
      name: "category_suggestion",
      description: "AI-generated category recommendation (e.g., Groceries, Salary).",
      type: "string",
      required: true,
    },
    {
      name: "direction",
      description: "Whether the transaction is an expense or income entry.",
      type: "enum",
      required: true,
    },
    {
      name: "raw_text",
      description: "Original user utterance used to derive the structured transaction.",
      type: "string",
      required: true,
    },
  ],
};

export function createLogCashTransactionTool(
  executor: LogCashTransactionExecutor,
) {
  const parametersSchema = z.object({
    amount: z.number(),
    description: z.string().min(1),
    category_suggestion: z.string().min(1),
    direction: z.enum(["expense", "income"]),
    raw_text: z.string().min(1),
  });

  const createTool = tool as unknown as (options: {
    name: string;
    description: string;
    parameters: typeof parametersSchema;
    execute: (payload: LogCashTransactionPayload) => Promise<{ status: "logged" }>;
  }) => Tool;

  return createTool({
    name: logCashTransactionToolDefinition.name,
    description: logCashTransactionToolDefinition.description,
    parameters: parametersSchema,
    execute: async (payload: LogCashTransactionPayload) => {
      await executor(payload);
      return { status: "logged" as const };
    },
  });
}
