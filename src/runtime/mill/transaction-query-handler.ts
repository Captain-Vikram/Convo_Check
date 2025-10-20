/**
 * Transaction Query Handler for Mill Agent
 * 
 * Uses LLM to understand user queries about transactions and retrieves appropriate data.
 * Example queries: "what were my transactions yesterday?", "show me last month's expenses"
 */

import { generateText } from "ai";
import { getAgentConfig, createLanguageModel } from "../../config.js";
import {
  readTransactionsFromCSV,
  queryTransactions,
  getYesterdayTransactions,
  getLastNDaysTransactions,
  getMonthTransactions,
  getCurrentMonthTransactions,
  getLastMonthTransactions,
  formatTransactionSummary,
  formatForLLMContext,
  type TransactionSummary,
  type TransactionQueryOptions,
} from "./transaction-reader.js";

export interface QueryIntent {
  type:
    | "yesterday"
    | "last_n_days"
    | "specific_date"
    | "current_month"
    | "last_month"
    | "specific_month"
    | "custom_range"
    | "all"
    | "unclear";
  parameters: {
    days?: number;
    startDate?: string;
    endDate?: string;
    year?: number;
    month?: number;
    transactionType?: "debit" | "credit" | "all";
    minAmount?: number;
    maxAmount?: number;
    merchant?: string;
    category?: string;
  };
  confidence: "high" | "medium" | "low";
  originalQuery: string;
}

export interface QueryResult {
  intent: QueryIntent;
  summary: TransactionSummary;
  userMessage: string;
  detailedMessage: string;
}

/**
 * Main entry point: Handle user's transaction query with LLM understanding
 */
export async function handleTransactionQuery(
  userQuery: string,
  csvPath?: string
): Promise<QueryResult> {
  // Step 1: Use LLM to understand the query intent
  const intent = await parseQueryIntent(userQuery);

  // Step 2: Fetch appropriate transactions based on intent
  const summary = await fetchTransactionsForIntent(intent, csvPath);

  // Step 3: Format the response
  const userMessage = formatTransactionSummary(summary);
  const detailedMessage = generateDetailedMessage(intent, summary);

  return {
    intent,
    summary,
    userMessage,
    detailedMessage,
  };
}

/**
 * Use LLM to parse user query and extract intent
 */
async function parseQueryIntent(userQuery: string): Promise<QueryIntent> {
  const systemPrompt = `You are a transaction query parser. Analyze user queries about financial transactions and extract structured intent.

USER QUERY PATTERNS:
- "yesterday" / "what did I spend yesterday" → type: yesterday
- "last 7 days" / "this week" → type: last_n_days, days: 7
- "last month" / "previous month" → type: last_month
- "this month" / "current month" → type: current_month
- "in October" / "October 2025" → type: specific_month, year: 2025, month: 10
- "all transactions" / "everything" → type: all
- "expenses" / "debits" → transactionType: debit
- "income" / "credits" → transactionType: credit

RESPONSE FORMAT (JSON):
{
  "type": "yesterday|last_n_days|specific_date|current_month|last_month|specific_month|custom_range|all|unclear",
  "parameters": {
    "days": <number>,
    "startDate": "YYYY-MM-DD",
    "endDate": "YYYY-MM-DD",
    "year": <number>,
    "month": <number 1-12>,
    "transactionType": "debit|credit|all",
    "minAmount": <number>,
    "maxAmount": <number>,
    "merchant": "<merchant name>",
    "category": "<category>"
  },
  "confidence": "high|medium|low"
}

Respond ONLY with valid JSON. Use "unclear" type if you can't understand the query.`;

  try {
    const config = getAgentConfig("agent1");
    const languageModel = createLanguageModel(config);

    const result = await generateText({
      model: languageModel,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Parse this query: "${userQuery}"\n\nCurrent date: ${new Date().toISOString().split("T")[0]}`,
        },
      ],
    });

    const text = result.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        type: parsed.type || "unclear",
        parameters: parsed.parameters || {},
        confidence: parsed.confidence || "low",
        originalQuery: userQuery,
      };
    }

    // Fallback
    return createFallbackIntent(userQuery);
  } catch (error) {
    console.error("[mill-query] Failed to parse intent with LLM", error);
    return createFallbackIntent(userQuery);
  }
}

/**
 * Create fallback intent when LLM fails
 */
function createFallbackIntent(query: string): QueryIntent {
  const lowerQuery = query.toLowerCase();

  // Simple pattern matching fallback
  if (lowerQuery.includes("yesterday")) {
    return {
      type: "yesterday",
      parameters: {},
      confidence: "medium",
      originalQuery: query,
    };
  }

  if (lowerQuery.includes("last month")) {
    return {
      type: "last_month",
      parameters: {},
      confidence: "medium",
      originalQuery: query,
    };
  }

  if (lowerQuery.includes("this month") || lowerQuery.includes("current month")) {
    return {
      type: "current_month",
      parameters: {},
      confidence: "medium",
      originalQuery: query,
    };
  }

  const daysMatch = lowerQuery.match(/last (\d+) days?/);
  if (daysMatch && daysMatch[1]) {
    const days = parseInt(daysMatch[1]);
    return {
      type: "last_n_days",
      parameters: { days },
      confidence: "medium",
      originalQuery: query,
    };
  }

  if (lowerQuery.includes("week")) {
    return {
      type: "last_n_days",
      parameters: { days: 7 },
      confidence: "medium",
      originalQuery: query,
    };
  }

  return {
    type: "unclear",
    parameters: {},
    confidence: "low",
    originalQuery: query,
  };
}

/**
 * Fetch transactions based on parsed intent
 */
async function fetchTransactionsForIntent(
  intent: QueryIntent,
  csvPath?: string
): Promise<TransactionSummary> {
  const { type, parameters } = intent;

  try {
    switch (type) {
      case "yesterday":
        return await getYesterdayTransactions(csvPath);

      case "last_n_days":
        const days = parameters.days || 7;
        return await getLastNDaysTransactions(days, csvPath);

      case "current_month":
        return await getCurrentMonthTransactions(csvPath);

      case "last_month":
        return await getLastMonthTransactions(csvPath);

      case "specific_month":
        if (parameters.year && parameters.month) {
          return await getMonthTransactions(parameters.year, parameters.month, csvPath);
        }
        // If only month, use current year
        if (parameters.month) {
          const currentYear = new Date().getFullYear();
          return await getMonthTransactions(currentYear, parameters.month, csvPath);
        }
        return await getCurrentMonthTransactions(csvPath);

      case "custom_range":
      case "specific_date":
        const options: TransactionQueryOptions = {};

        if (parameters.startDate) {
          options.startDate = new Date(parameters.startDate);
        }
        if (parameters.endDate) {
          options.endDate = new Date(parameters.endDate);
        }
        if (parameters.transactionType) {
          options.type = parameters.transactionType;
        }
        if (parameters.minAmount) {
          options.minAmount = parameters.minAmount;
        }
        if (parameters.maxAmount) {
          options.maxAmount = parameters.maxAmount;
        }
        if (parameters.merchant) {
          options.targetParty = parameters.merchant;
        }
        if (parameters.category) {
          options.category = parameters.category;
        }

        return await queryTransactions(options, csvPath);

      case "all":
        return await queryTransactions({}, csvPath);

      case "unclear":
      default:
        // Default to last 30 days
        return await getLastNDaysTransactions(30, csvPath);
    }
  } catch (error) {
    console.error("[mill-query] Failed to fetch transactions", error);
    return {
      totalTransactions: 0,
      totalDebits: 0,
      totalCredits: 0,
      netAmount: 0,
      transactions: [],
      dateRange: { from: "N/A", to: "N/A" },
    };
  }
}

/**
 * Generate detailed message using LLM with transaction context
 */
function generateDetailedMessage(intent: QueryIntent, summary: TransactionSummary): string {
  if (summary.totalTransactions === 0) {
    return generateNoTransactionsMessage(intent);
  }

  return formatTransactionSummary(summary);
}

/**
 * Generate friendly "no transactions" message
 */
function generateNoTransactionsMessage(intent: QueryIntent): string {
  const { type, parameters } = intent;

  switch (type) {
    case "yesterday":
      return "You didn't have any transactions yesterday. 🎉 A no-spend day!";

    case "last_n_days":
      const days = parameters.days || 7;
      return `No transactions found in the last ${days} days.`;

    case "current_month":
      return "No transactions recorded for this month yet.";

    case "last_month":
      return "No transactions found for last month.";

    case "specific_month":
      const monthName = parameters.month
        ? new Date(2000, parameters.month - 1).toLocaleString("default", { month: "long" })
        : "that month";
      return `No transactions found for ${monthName}.`;

    default:
      return "No transactions found for the specified period.";
  }
}

/**
 * Quick helper: Get yesterday's transactions formatted
 */
export async function getYesterdayTransactionsFormatted(csvPath?: string): Promise<string> {
  const summary = await getYesterdayTransactions(csvPath);
  return formatTransactionSummary(summary);
}

/**
 * Quick helper: Get last 7 days formatted
 */
export async function getLastWeekTransactionsFormatted(csvPath?: string): Promise<string> {
  const summary = await getLastNDaysTransactions(7, csvPath);
  return formatTransactionSummary(summary);
}

/**
 * Quick helper: Get current month formatted
 */
export async function getCurrentMonthTransactionsFormatted(csvPath?: string): Promise<string> {
  const summary = await getCurrentMonthTransactions(csvPath);
  return formatTransactionSummary(summary);
}
