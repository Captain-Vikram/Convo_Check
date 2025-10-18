/**
 * Param Agent - Habit Tracker
 * 
 * Analyzes transactions and builds spending habit profiles.
 * Creates habit snapshots after each transaction for pattern detection.
 * 
 * Features:
 * - Incremental habit analysis (triggered by new transactions)
 * - Context-aware learning (uses last 5 transactions + previous habits)
 * - Vector-like snapshots for Chatur's coaching insights
 * - Progressive pattern detection
 */

import { readFile, appendFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";

export interface Transaction {
  ownerPhone: string;
  transactionId: string;
  datetime: string;
  date: string;
  time: string;
  amount: number;
  currency: string;
  type: "debit" | "credit" | "income" | "expense";
  targetParty: string;
  description: string;
  category: string;
  isFinancial: boolean;
  medium: string;
}

export interface HabitEntry {
  habitId: string;
  recordedAt: string;
  transactionId: string;
  transactionDate: string;
  transactionAmount: number;
  transactionType: string;
  targetParty: string;
  category: string;
  
  // Habit Analysis
  spendingPattern: string;
  frequency: string;
  averageAmount: number;
  totalSpent: number;
  transactionCount: number;
  
  // Insights
  habitType: string; // "recurring", "one-time", "irregular", "frequent-small", "occasional-large"
  riskLevel: string; // "low", "moderate", "high"
  suggestions: string;
  
  // Context
  recentTransactions: string; // Last 5 transaction IDs
  previousHabitId: string; // Links to previous habit snapshot
}

export interface HabitSnapshot {
  snapshotId: string;
  createdAt: string;
  transactionId: string;
  ownerPhone: string;
  
  // Context Used for Analysis (for Chatur's reference)
  contextTransactions: Array<{
    transactionId: string;
    date: string;
    amount: number;
    type: string;
    targetParty: string;
    category: string;
  }>;
  contextHabits: Array<{
    habitId: string;
    transactionDate: string;
    habitType: string;
    spendingPattern: string;
    frequency: string;
    suggestions: string;
  }>;
  
  // Spending Summary
  totalDebits: number;
  totalCredits: number;
  netBalance: number;
  transactionCount: number;
  
  // Patterns
  topCategories: Array<{ category: string; amount: number; count: number }>;
  frequentMerchants: Array<{ merchant: string; amount: number; count: number }>;
  spendingByMedium: Array<{ medium: string; amount: number; count: number }>;
  
  // Behavioral Insights
  averageTransactionSize: number;
  largestTransaction: number;
  smallestTransaction: number;
  mostActiveTime: string; // "morning", "afternoon", "evening", "night"
  mostActiveDay: string;
  
  // Habit Indicators
  isOverspending: boolean;
  hasRecurringPayments: boolean;
  showsImpulseBuying: boolean;
  needsBudgetAlert: boolean;
  
  // AI Analysis
  behaviorSummary: string;
  recommendations: string[];
}

export interface HabitTrackerOptions {
  baseDir?: string;
  transactionsFile?: string;
  habitsFile?: string;
  snapshotsDir?: string;
  lookbackCount?: number; // How many previous transactions to analyze
  model?: string;
}

const HABITS_HEADER = [
  "habit_id",
  "recorded_at",
  "transaction_id",
  "transaction_date",
  "transaction_amount",
  "transaction_type",
  "target_party",
  "category",
  "spending_pattern",
  "frequency",
  "average_amount",
  "total_spent",
  "transaction_count",
  "habit_type",
  "risk_level",
  "suggestions",
  "recent_transactions",
  "previous_habit_id",
].join(",");

/**
 * Analyzes a new transaction and updates habit tracking
 */
export async function analyzeTransactionHabit(
  transaction: Transaction,
  options: HabitTrackerOptions = {},
): Promise<{ habitEntry: HabitEntry; snapshot: HabitSnapshot }> {
  const baseDir = options.baseDir ?? join(process.cwd(), "data");
  const transactionsFile = join(baseDir, options.transactionsFile ?? "transactions.csv");
  const habitsFile = join(baseDir, options.habitsFile ?? "habits.csv");
  const snapshotsDir = join(baseDir, options.snapshotsDir ?? "habit-snapshots");
  const lookbackCount = options.lookbackCount ?? 5;
  const model = options.model ?? "gemini-2.0-flash-exp";

  // Ensure habits CSV exists
  await ensureHabitsFile(habitsFile);

  // Load context: recent transactions + previous habits
  const recentTransactions = await loadRecentTransactions(transactionsFile, lookbackCount);
  const previousHabits = await loadRecentHabits(habitsFile, 3);
  
  // Analyze with LLM
  const analysis = await analyzeWithLLM(
    transaction,
    recentTransactions,
    previousHabits,
    model,
  );

  // Create habit entry
  const habitEntry = buildHabitEntry(transaction, analysis, previousHabits);

  // Create snapshot for vector reference (includes context for Chatur)
  const snapshot = await buildHabitSnapshot(
    transaction,
    recentTransactions,
    habitEntry,
    snapshotsDir,
    previousHabits,
  );

  // Append to habits CSV
  await appendFile(habitsFile, `${serializeHabitEntry(habitEntry)}\n`, "utf8");

  return { habitEntry, snapshot };
}

/**
 * Initializes habit tracking from existing transactions
 */
export async function initializeHabitsFromTransactions(
  options: HabitTrackerOptions = {},
): Promise<number> {
  const baseDir = options.baseDir ?? join(process.cwd(), "data");
  const transactionsFile = join(baseDir, options.transactionsFile ?? "transactions.csv");
  const habitsFile = join(baseDir, options.habitsFile ?? "habits.csv");

  console.log("🔄 Initializing habits from existing transactions...");

  // Load all transactions
  const transactions = await loadAllTransactions(transactionsFile);
  
  if (transactions.length === 0) {
    console.log("⚠️  No transactions found");
    return 0;
  }

  console.log(`📊 Processing ${transactions.length} transactions...`);

  // Clear existing habits file
  await writeFile(habitsFile, `${HABITS_HEADER}\n`, "utf8");

  let processed = 0;
  
  // Process each transaction sequentially to build context
  for (const transaction of transactions) {
    try {
      await analyzeTransactionHabit(transaction, options);
      processed++;
      
      if (processed % 5 === 0) {
        console.log(`   Processed ${processed}/${transactions.length}...`);
      }
    } catch (error) {
      console.error(`   Failed to process transaction ${transaction.transactionId}:`, error);
    }
  }

  console.log(`✅ Initialized ${processed} habit entries`);
  return processed;
}

/**
 * Analyzes transaction with LLM using context
 */
async function analyzeWithLLM(
  transaction: Transaction,
  recentTransactions: Transaction[],
  previousHabits: HabitEntry[],
  model: string,
): Promise<{
  spendingPattern: string;
  frequency: string;
  habitType: string;
  riskLevel: string;
  suggestions: string;
  behaviorSummary: string;
}> {
  const prompt = buildAnalysisPrompt(transaction, recentTransactions, previousHabits);

  try {
    const { text } = await generateText({
      model: google(model),
      prompt,
      temperature: 0.3,
    });

    return parseAnalysisResponse(text);
  } catch (error) {
    console.error("[habit-tracker] LLM analysis failed:", error);
    
    // Fallback to rule-based analysis
    return fallbackAnalysis(transaction, recentTransactions);
  }
}

/**
 * Builds analysis prompt with context
 */
function buildAnalysisPrompt(
  transaction: Transaction,
  recentTransactions: Transaction[],
  previousHabits: HabitEntry[],
): string {
  const recentContext = recentTransactions.length > 0
    ? recentTransactions.map((t, idx) => 
        `${idx + 1}. ${t.date} - ${t.type} ${t.amount} ${t.currency} to ${t.targetParty || 'N/A'} (${t.category})`
      ).join("\n")
    : "No previous transactions";

  const habitContext = previousHabits.length > 0
    ? previousHabits.map((h, idx) =>
        `${idx + 1}. ${h.habitType} - ${h.spendingPattern} (${h.frequency})`
      ).join("\n")
    : "No previous habit data";

  return `Analyze this financial transaction and identify spending habits for a gig worker.

**Current Transaction:**
- Date: ${transaction.date} ${transaction.time}
- Type: ${transaction.type}
- Amount: ${transaction.amount} ${transaction.currency}
- Target: ${transaction.targetParty || 'N/A'}
- Category: ${transaction.category}
- Description: ${transaction.description}

**Recent Transactions (Last ${recentTransactions.length}):**
${recentContext}

**Previous Habit Insights:**
${habitContext}

**Analyze and provide:**
1. **Spending Pattern**: Describe the pattern (e.g., "Regular small payments to same merchant", "One-time large expense")
2. **Frequency**: How often similar transactions occur (e.g., "daily", "weekly", "monthly", "irregular")
3. **Habit Type**: Classify as one of: "recurring", "one-time", "irregular", "frequent-small", "occasional-large"
4. **Risk Level**: Assess financial risk: "low", "moderate", "high"
5. **Suggestions**: Brief actionable advice (1 sentence)
6. **Behavior Summary**: Overall spending behavior insight (2-3 sentences)

**Response Format (JSON):**
{
  "spendingPattern": "...",
  "frequency": "...",
  "habitType": "...",
  "riskLevel": "...",
  "suggestions": "...",
  "behaviorSummary": "..."
}`;
}

/**
 * Parses LLM response
 */
function parseAnalysisResponse(text: string): {
  spendingPattern: string;
  frequency: string;
  habitType: string;
  riskLevel: string;
  suggestions: string;
  behaviorSummary: string;
} {
  try {
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        spendingPattern: parsed.spendingPattern || "Unknown pattern",
        frequency: parsed.frequency || "irregular",
        habitType: parsed.habitType || "one-time",
        riskLevel: parsed.riskLevel || "moderate",
        suggestions: parsed.suggestions || "Track spending regularly",
        behaviorSummary: parsed.behaviorSummary || "Transaction recorded",
      };
    }
  } catch (error) {
    console.error("[habit-tracker] Failed to parse LLM response:", error);
  }

  // Fallback parsing
  return {
    spendingPattern: extractField(text, "spending pattern:", "frequency:") || "Unknown pattern",
    frequency: extractField(text, "frequency:", "habit type:") || "irregular",
    habitType: extractField(text, "habit type:", "risk level:") || "one-time",
    riskLevel: extractField(text, "risk level:", "suggestions:") || "moderate",
    suggestions: extractField(text, "suggestions:", "behavior") || "Monitor spending",
    behaviorSummary: extractField(text, "behavior summary:", null) || "Transaction logged",
  };
}

function extractField(text: string, startMarker: string, endMarker: string | null): string | null {
  const lowerText = text.toLowerCase();
  const startIdx = lowerText.indexOf(startMarker);
  
  if (startIdx === -1) return null;
  
  const valueStart = startIdx + startMarker.length;
  const endIdx = endMarker ? lowerText.indexOf(endMarker, valueStart) : text.length;
  
  const value = text.substring(valueStart, endIdx === -1 ? text.length : endIdx).trim();
  return value.replace(/^[":]+|[":]+$/g, "").trim();
}

/**
 * Fallback rule-based analysis
 */
function fallbackAnalysis(
  transaction: Transaction,
  recentTransactions: Transaction[],
): {
  spendingPattern: string;
  frequency: string;
  habitType: string;
  riskLevel: string;
  suggestions: string;
  behaviorSummary: string;
} {
  // Check for similar transactions
  const similarCount = recentTransactions.filter(
    t => t.targetParty === transaction.targetParty && Math.abs(t.amount - transaction.amount) < 10
  ).length;

  const frequency = similarCount >= 3 ? "frequent" : similarCount >= 1 ? "occasional" : "rare";
  const habitType = similarCount >= 3 ? "recurring" : transaction.amount > 500 ? "occasional-large" : "one-time";
  const riskLevel = transaction.amount > 1000 ? "high" : transaction.amount > 100 ? "moderate" : "low";

  return {
    spendingPattern: similarCount >= 2 
      ? `Repeat payment to ${transaction.targetParty || 'merchant'}`
      : `One-time ${transaction.type} transaction`,
    frequency,
    habitType,
    riskLevel,
    suggestions: transaction.amount > 500 
      ? "Consider budgeting for large expenses"
      : "Track small frequent expenses",
    behaviorSummary: `${transaction.type} of ${transaction.amount} ${transaction.currency}. Pattern: ${frequency} ${habitType}.`,
  };
}

/**
 * Builds habit entry from analysis
 */
function buildHabitEntry(
  transaction: Transaction,
  analysis: ReturnType<typeof parseAnalysisResponse>,
  previousHabits: HabitEntry[],
): HabitEntry {
  const habitId = generateHabitId(transaction);
  const previousHabitId = previousHabits.length > 0 && previousHabits[0] ? previousHabits[0].habitId : "";

  // Calculate aggregates (simple running totals)
  const totalSpent = transaction.type === "debit" || transaction.type === "expense"
    ? transaction.amount
    : 0;
  
  return {
    habitId,
    recordedAt: new Date().toISOString(),
    transactionId: transaction.transactionId,
    transactionDate: transaction.date,
    transactionAmount: transaction.amount,
    transactionType: transaction.type,
    targetParty: transaction.targetParty,
    category: transaction.category,
    spendingPattern: analysis.spendingPattern,
    frequency: analysis.frequency,
    averageAmount: transaction.amount, // Will be updated in aggregate analysis
    totalSpent,
    transactionCount: 1,
    habitType: analysis.habitType,
    riskLevel: analysis.riskLevel,
    suggestions: analysis.suggestions,
    recentTransactions: transaction.transactionId,
    previousHabitId,
  };
}

/**
 * Builds habit snapshot for vector reference
 */
async function buildHabitSnapshot(
  transaction: Transaction,
  recentTransactions: Transaction[],
  habitEntry: HabitEntry,
  snapshotsDir: string,
  previousHabits: HabitEntry[] = [],
): Promise<HabitSnapshot> {
  const allTransactions = [...recentTransactions, transaction];
  
  // Prepare context data for Chatur
  const contextTransactions = recentTransactions.map(t => ({
    transactionId: t.transactionId,
    date: t.date,
    amount: t.amount,
    type: t.type,
    targetParty: t.targetParty,
    category: t.category,
  }));
  
  const contextHabits = previousHabits.map(h => ({
    habitId: h.habitId,
    transactionDate: h.transactionDate,
    habitType: h.habitType,
    spendingPattern: h.spendingPattern,
    frequency: h.frequency,
    suggestions: h.suggestions,
  }));
  
  // Calculate aggregates
  const debits = allTransactions.filter(t => t.type === "debit" || t.type === "expense");
  const credits = allTransactions.filter(t => t.type === "credit" || t.type === "income");
  
  const totalDebits = debits.reduce((sum, t) => sum + t.amount, 0);
  const totalCredits = credits.reduce((sum, t) => sum + t.amount, 0);
  
  // Group by category
  const categoryMap = new Map<string, { amount: number; count: number }>();
  allTransactions.forEach(t => {
    const existing = categoryMap.get(t.category) || { amount: 0, count: 0 };
    categoryMap.set(t.category, {
      amount: existing.amount + t.amount,
      count: existing.count + 1,
    });
  });
  
  const topCategories = Array.from(categoryMap.entries())
    .map(([category, data]) => ({ category, ...data }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  // Group by merchant
  const merchantMap = new Map<string, { amount: number; count: number }>();
  allTransactions.forEach(t => {
    if (!t.targetParty) return;
    const existing = merchantMap.get(t.targetParty) || { amount: 0, count: 0 };
    merchantMap.set(t.targetParty, {
      amount: existing.amount + t.amount,
      count: existing.count + 1,
    });
  });
  
  const frequentMerchants = Array.from(merchantMap.entries())
    .map(([merchant, data]) => ({ merchant, ...data }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Time analysis
  const hours = allTransactions.map(t => {
    const time = t.time.split(":")[0] || "12";
    return parseInt(time, 10);
  });
  
  const avgHour = hours.reduce((sum, h) => sum + h, 0) / hours.length;
  const mostActiveTime = 
    avgHour < 6 ? "night" :
    avgHour < 12 ? "morning" :
    avgHour < 18 ? "afternoon" : "evening";

  const snapshot: HabitSnapshot = {
    snapshotId: generateHabitId(transaction),
    createdAt: new Date().toISOString(),
    transactionId: transaction.transactionId,
    ownerPhone: transaction.ownerPhone,
    
    // Include context used for analysis
    contextTransactions,
    contextHabits,
    
    totalDebits,
    totalCredits,
    netBalance: totalCredits - totalDebits,
    transactionCount: allTransactions.length,
    topCategories,
    frequentMerchants,
    spendingByMedium: [],
    averageTransactionSize: allTransactions.reduce((sum, t) => sum + t.amount, 0) / allTransactions.length,
    largestTransaction: Math.max(...allTransactions.map(t => t.amount)),
    smallestTransaction: Math.min(...allTransactions.map(t => t.amount)),
    mostActiveTime,
    mostActiveDay: transaction.date.split("-")[2] || "01", // Day of month
    isOverspending: totalDebits > totalCredits * 1.5,
    hasRecurringPayments: frequentMerchants.some(m => m.count >= 3),
    showsImpulseBuying: debits.length > credits.length * 2,
    needsBudgetAlert: totalDebits > 5000,
    behaviorSummary: habitEntry.suggestions,
    recommendations: [habitEntry.suggestions],
  };

  // Save snapshot
  await saveSnapshot(snapshot, snapshotsDir);

  return snapshot;
}

/**
 * Saves snapshot to file
 */
async function saveSnapshot(snapshot: HabitSnapshot, snapshotsDir: string): Promise<void> {
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(snapshotsDir, { recursive: true });
    
    const filePath = join(snapshotsDir, `${snapshot.snapshotId}.json`);
    await writeFile(filePath, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (error) {
    console.error("[habit-tracker] Failed to save snapshot:", error);
  }
}

/**
 * Generates habit ID
 */
function generateHabitId(transaction: Transaction): string {
  const data = `${transaction.transactionId}-${transaction.date}-${Date.now()}`;
  return createHash("sha1").update(data).digest("hex");
}

/**
 * Ensures habits CSV file exists
 */
async function ensureHabitsFile(filePath: string): Promise<void> {
  try {
    await access(filePath, constants.F_OK);
  } catch {
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${HABITS_HEADER}\n`, "utf8");
  }
}

/**
 * Loads recent transactions
 */
async function loadRecentTransactions(
  filePath: string,
  count: number,
): Promise<Transaction[]> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    
    if (lines.length <= 1) return [];
    
    const transactions: Transaction[] = [];
    
    // Read from end (most recent)
    for (let i = Math.max(1, lines.length - count); i < lines.length; i++) {
      try {
        const line = lines[i];
        if (!line) continue;
        const transaction = parseTransactionLine(line);
        if (transaction) transactions.push(transaction);
      } catch (error) {
        // Skip invalid lines
      }
    }
    
    return transactions.reverse(); // Most recent first
  } catch (error) {
    return [];
  }
}

/**
 * Loads all transactions
 */
async function loadAllTransactions(filePath: string): Promise<Transaction[]> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    
    if (lines.length <= 1) return [];
    
    const transactions: Transaction[] = [];
    
    for (let i = 1; i < lines.length; i++) {
      try {
        const line = lines[i];
        if (!line) continue;
        const transaction = parseTransactionLine(line);
        if (transaction) transactions.push(transaction);
      } catch (error) {
        console.error(`Failed to parse line ${i}:`, error);
      }
    }
    
    return transactions;
  } catch (error) {
    console.error("[habit-tracker] Failed to load transactions:", error);
    return [];
  }
}

/**
 * Parses transaction CSV line
 */
function parseTransactionLine(line: string): Transaction | null {
  const values = parseCsvLine(line);
  
  if (values.length < 13) return null;
  
  return {
    ownerPhone: values[0] || "",
    transactionId: values[1] || "",
    datetime: values[2] || "",
    date: values[3] || "",
    time: values[4] || "00:00:00",
    amount: parseFloat(values[5] || "0") || 0,
    currency: values[6] || "",
    type: (values[7] || "expense") as any,
    targetParty: values[8] || "",
    description: values[9] || "",
    category: values[10] || "",
    isFinancial: values[11] === "true",
    medium: values[12] || "",
  };
}

/**
 * Parses CSV line
 */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      const nextChar = line[i + 1];
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

/**
 * Loads recent habit entries
 */
async function loadRecentHabits(filePath: string, count: number): Promise<HabitEntry[]> {
  try {
    await access(filePath, constants.F_OK);
    
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    
    if (lines.length <= 1) return [];
    
    const habits: HabitEntry[] = [];
    
    for (let i = Math.max(1, lines.length - count); i < lines.length; i++) {
      try {
        const line = lines[i];
        if (!line) continue;
        const habit = parseHabitLine(line);
        if (habit) habits.push(habit);
      } catch (error) {
        // Skip invalid lines
      }
    }
    
    return habits.reverse();
  } catch (error) {
    return [];
  }
}

/**
 * Parses habit CSV line
 */
function parseHabitLine(line: string): HabitEntry | null {
  const values = parseCsvLine(line);
  
  if (values.length < 18) return null;
  
  return {
    habitId: values[0] || "",
    recordedAt: values[1] || "",
    transactionId: values[2] || "",
    transactionDate: values[3] || "",
    transactionAmount: parseFloat(values[4] || "0") || 0,
    transactionType: values[5] || "",
    targetParty: values[6] || "",
    category: values[7] || "",
    spendingPattern: values[8] || "",
    frequency: values[9] || "",
    averageAmount: parseFloat(values[10] || "0") || 0,
    totalSpent: parseFloat(values[11] || "0") || 0,
    transactionCount: parseInt(values[12] || "0", 10) || 0,
    habitType: values[13] || "",
    riskLevel: values[14] || "",
    suggestions: values[15] || "",
    recentTransactions: values[16] || "",
    previousHabitId: values[17] || "",
  };
}

/**
 * Serializes habit entry to CSV
 */
function serializeHabitEntry(entry: HabitEntry): string {
  return [
    entry.habitId,
    entry.recordedAt,
    entry.transactionId,
    entry.transactionDate,
    entry.transactionAmount,
    entry.transactionType,
    entry.targetParty,
    entry.category,
    entry.spendingPattern,
    entry.frequency,
    entry.averageAmount,
    entry.totalSpent,
    entry.transactionCount,
    entry.habitType,
    entry.riskLevel,
    entry.suggestions,
    entry.recentTransactions,
    entry.previousHabitId,
  ]
    .map(v => {
      const str = String(v ?? "");
      const escaped = str.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(",");
}
