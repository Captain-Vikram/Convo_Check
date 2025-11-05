/**
 * Transaction Reader for Mill Agent
 * 
 * Reads transaction data via the Transactions API and formats it for user presentation.
 * Legacy CSV helpers remain for compatibility with existing callers but now proxy to
 * the API-backed data source introduced during the DB migration.
 */

import { fetchTransactionsFromApi } from "../dev/api-sync.js";
import type { NormalizedTransaction } from "../dev/transaction-normalizer.js";

export interface TransactionRecord {
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

export interface TransactionQueryOptions {
  startDate?: Date;
  endDate?: Date;
  type?: "debit" | "credit" | "all";
  minAmount?: number;
  maxAmount?: number;
  targetParty?: string;
  category?: string;
  limit?: number;
}

export interface TransactionSummary {
  totalTransactions: number;
  totalDebits: number;
  totalCredits: number;
  netAmount: number;
  transactions: TransactionRecord[];
  dateRange: {
    from: string;
    to: string;
  };
}

/**
 * Read and parse transactions from CSV
 */
export async function readTransactionsFromCSV(
  csvPath?: string,
): Promise<TransactionRecord[]> {
  try {
    void csvPath; // parameter retained for compatibility but ignored.
    const apiTransactions = await fetchTransactionsFromApi();
    const records = apiTransactions
      .map(transformNormalizedTransaction)
      .filter((record): record is TransactionRecord => record !== null);

    records.sort((a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime());
    return records;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[mill-reader] Failed to load transactions from API", message);
    return [];
  }
}

/**
 * Query transactions with filters
 */
export async function queryTransactions(
  options: TransactionQueryOptions = {},
  csvPath?: string
): Promise<TransactionSummary> {
  const allTransactions = await readTransactionsFromCSV(csvPath);
  
  let filtered = allTransactions;

  // Apply filters
  if (options.startDate) {
    filtered = filtered.filter(t => 
      new Date(t.datetime) >= options.startDate!
    );
  }

  if (options.endDate) {
    filtered = filtered.filter(t => 
      new Date(t.datetime) <= options.endDate!
    );
  }

  if (options.type && options.type !== "all") {
    filtered = filtered.filter(t => t.type === options.type);
  }

  if (options.minAmount !== undefined) {
    filtered = filtered.filter(t => t.amount >= options.minAmount!);
  }

  if (options.maxAmount !== undefined) {
    filtered = filtered.filter(t => t.amount <= options.maxAmount!);
  }

  if (options.targetParty) {
    const search = options.targetParty.toLowerCase();
    filtered = filtered.filter(t => 
      t.targetParty.toLowerCase().includes(search)
    );
  }

  if (options.category) {
    const search = options.category.toLowerCase();
    filtered = filtered.filter(t => 
      t.category.toLowerCase().includes(search)
    );
  }

  // Apply limit
  if (options.limit) {
    filtered = filtered.slice(0, options.limit);
  }

  // Calculate summary
  const totalDebits = filtered
    .filter(t => t.type === "debit")
    .reduce((sum, t) => sum + t.amount, 0);

  const totalCredits = filtered
    .filter(t => t.type === "credit")
    .reduce((sum, t) => sum + t.amount, 0);

  const lastTx = filtered[filtered.length - 1];
  const firstTx = filtered[0];
  
  const dateRange = {
    from: lastTx?.date ?? "N/A",
    to: firstTx?.date ?? "N/A",
  };

  return {
    totalTransactions: filtered.length,
    totalDebits,
    totalCredits,
    netAmount: totalCredits - totalDebits,
    transactions: filtered,
    dateRange,
  };
}

function transformNormalizedTransaction(transaction: NormalizedTransaction): TransactionRecord | null {
  if (!transaction.recordedAt || !transaction.id) {
    return null;
  }

  const datetime = transaction.recordedAt;
  const date = transaction.eventDate || datetime.split("T")[0] || "";
  const time = transaction.eventTime || extractTime(datetime);
  const currency = transaction.currency ?? "INR";
  const amount = Number.isFinite(transaction.amount) ? transaction.amount : 0;
  const type: "debit" | "credit" = transaction.direction === "income" ? "credit" : "debit";

  return {
    ownerPhone: transaction.meta.source ?? "unknown",
    transactionId: transaction.id,
    datetime,
    date,
    time,
    amount,
    currency,
    type,
    targetParty: transaction.meta.targetParty ?? "",
    description: transaction.description,
    category: transaction.category,
    isFinancial: true,
    medium: transaction.meta.medium ?? "",
  };
}

function extractTime(isoString: string): string {
  const [, timePart] = isoString.split("T");
  if (!timePart) {
    return "";
  }

  return timePart.slice(0, 8);
}

/**
 * Get transactions for yesterday
 */
export async function getYesterdayTransactions(csvPath?: string): Promise<TransactionSummary> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  const endOfYesterday = new Date(today);
  endOfYesterday.setMilliseconds(-1);

  return queryTransactions({
    startDate: yesterday,
    endDate: endOfYesterday,
  }, csvPath);
}

/**
 * Get transactions for last N days
 */
export async function getLastNDaysTransactions(
  days: number,
  csvPath?: string
): Promise<TransactionSummary> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);

  return queryTransactions({
    startDate,
    endDate,
  }, csvPath);
}

/**
 * Get transactions for a specific month
 */
export async function getMonthTransactions(
  year: number,
  month: number, // 1-12
  csvPath?: string
): Promise<TransactionSummary> {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59, 999);

  return queryTransactions({
    startDate,
    endDate,
  }, csvPath);
}

/**
 * Get current month transactions
 */
export async function getCurrentMonthTransactions(csvPath?: string): Promise<TransactionSummary> {
  const now = new Date();
  return getMonthTransactions(now.getFullYear(), now.getMonth() + 1, csvPath);
}

/**
 * Get last month transactions
 */
export async function getLastMonthTransactions(csvPath?: string): Promise<TransactionSummary> {
  const now = new Date();
  const lastMonth = now.getMonth() === 0 ? 12 : now.getMonth();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  
  return getMonthTransactions(year, lastMonth, csvPath);
}

/**
 * Format transaction summary for LLM/user presentation
 */
export function formatTransactionSummary(summary: TransactionSummary): string {
  if (summary.totalTransactions === 0) {
    return "No transactions found for the specified period.";
  }

  const lines: string[] = [];
  
  lines.push(`📊 Transaction Summary (${summary.dateRange.from} to ${summary.dateRange.to})`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Total Transactions: ${summary.totalTransactions}`);
  lines.push(`💸 Total Debits: ${summary.totalDebits.toFixed(2)}`);
  lines.push(`💰 Total Credits: ${summary.totalCredits.toFixed(2)}`);
  lines.push(`📈 Net Amount: ${summary.netAmount.toFixed(2)}`);
  lines.push(``);
  lines.push(`Transactions:`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  for (const tx of summary.transactions) {
    const icon = tx.type === "debit" ? "🔴" : "🟢";
    const sign = tx.type === "debit" ? "-" : "+";
    
    lines.push(`${icon} ${tx.date} ${tx.time}`);
    lines.push(`   ${sign}${tx.amount} ${tx.currency}`);
    
    if (tx.targetParty) {
      lines.push(`   To/From: ${tx.targetParty}`);
    }
    
    if (tx.description) {
      lines.push(`   ${tx.description}`);
    }
    
    lines.push(`   Category: ${tx.category}`);
    lines.push(``);
  }

  return lines.join("\n");
}

/**
 * Format transaction summary for LLM context (compact)
 */
export function formatForLLMContext(summary: TransactionSummary): string {
  const lines: string[] = [];
  
  lines.push(`Period: ${summary.dateRange.from} to ${summary.dateRange.to}`);
  lines.push(`Total: ${summary.totalTransactions} transactions`);
  lines.push(`Debits: ${summary.totalDebits.toFixed(2)}, Credits: ${summary.totalCredits.toFixed(2)}, Net: ${summary.netAmount.toFixed(2)}`);
  lines.push(``);

  for (const tx of summary.transactions) {
    const sign = tx.type === "debit" ? "-" : "+";
    lines.push(`${tx.date} ${tx.time}: ${sign}${tx.amount} ${tx.currency} | ${tx.targetParty || "N/A"} | ${tx.category}`);
  }

  return lines.join("\n");
}
