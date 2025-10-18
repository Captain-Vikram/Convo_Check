/**
 * Transaction Reader for Mill Agent
 * 
 * Reads transaction data directly from CSV and formats it for user presentation.
 * NO interaction with Dev agent - direct CSV reading only.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
  csvPath: string = join(process.cwd(), "data", "transactions.csv")
): Promise<TransactionRecord[]> {
  if (!existsSync(csvPath)) {
    console.warn(`[mill-reader] Transaction CSV not found: ${csvPath}`);
    return [];
  }

  try {
    const content = await readFile(csvPath, "utf-8");
    const lines = content.trim().split("\n");

    if (lines.length <= 1) {
      // Only header or empty
      return [];
    }

    // Skip header
    const dataLines = lines.slice(1);
    const transactions: TransactionRecord[] = [];

    for (const line of dataLines) {
      const parsed = parseCsvLine(line);
      if (parsed) {
        transactions.push(parsed);
      }
    }

    // Sort by datetime (newest first)
    transactions.sort((a, b) => 
      new Date(b.datetime).getTime() - new Date(a.datetime).getTime()
    );

    return transactions;
  } catch (error) {
    console.error("[mill-reader] Failed to read transactions CSV", error);
    return [];
  }
}

/**
 * Parse a single CSV line into TransactionRecord
 * Format: owner_phone,transaction_id,datetime,date,time,amount,currency,type,target_party,description,category,is_financial,medium
 */
function parseCsvLine(line: string): TransactionRecord | null {
  try {
    // Split by comma but respect quoted fields
    const fields = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || [];
    
    if (fields.length < 13) {
      return null;
    }

    // Clean quoted fields
    const clean = (val: string | undefined) => (val || "").replace(/^"|"$/g, "").trim();

    const ownerPhone = clean(fields[0]);
    const transactionId = clean(fields[1]);
    const datetime = clean(fields[2]);
    const date = clean(fields[3]);
    const time = clean(fields[4]);
    const amount = parseFloat(clean(fields[5]));
    const currency = clean(fields[6]);
    const type = clean(fields[7]) as "debit" | "credit";
    const targetParty = clean(fields[8]);
    const description = clean(fields[9]);
    const category = clean(fields[10]);
    const isFinancial = clean(fields[11]).toLowerCase() === "true";
    const medium = clean(fields[12]);

    return {
      ownerPhone,
      transactionId,
      datetime,
      date,
      time,
      amount,
      currency,
      type,
      targetParty,
      description,
      category,
      isFinancial,
      medium,
    };
  } catch (error) {
    console.error("[mill-reader] Failed to parse CSV line", error);
    return null;
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
