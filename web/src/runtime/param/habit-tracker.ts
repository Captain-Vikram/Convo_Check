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

import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { prisma } from "@/lib/prisma";
import { logger } from "../shared/logger";
import { loadTransactions } from "./transactions-loader";

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
  lookbackCount?: number; // How many previous transactions to analyze
  model?: string;
  ownerId?: number; // Database owner ID for API calls
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
  const lookbackCount = options.lookbackCount ?? 5;
  const model = options.model ?? "gemini-2.0-flash-exp";
  const ownerId = options.ownerId ?? (process.env.DEV_USER_ID ? Number(process.env.DEV_USER_ID) : undefined);

  if (!ownerId) {
    throw new Error("ownerId is required for habit analysis");
  }

  // Load context from database: recent transactions + previous habits
  const recentTransactions = await loadRecentTransactions(lookbackCount, ownerId);
  const previousHabits = await loadRecentHabits(3, ownerId);
  
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
    previousHabits,
    ownerId,
  );

  const metricsPayload = {
    habitType: habitEntry.habitType,
    spendingPattern: habitEntry.spendingPattern,
    frequency: habitEntry.frequency,
    riskLevel: habitEntry.riskLevel,
    averageAmount: habitEntry.averageAmount,
    totalSpent: habitEntry.totalSpent,
    transactionCount: habitEntry.transactionCount,
    context: {
      habitId: habitEntry.habitId,
      transactionId: habitEntry.transactionId,
      targetParty: habitEntry.targetParty,
      category: habitEntry.category,
      recentTransactions: habitEntry.recentTransactions,
      previousHabitId: habitEntry.previousHabitId,
    },
  } satisfies Record<string, unknown>;

  // Sync habit to database via Prisma
  try {
    await prisma.habit_insights.create({
      data: {
        habit_id: habitEntry.habitId,
        habit_label: `${habitEntry.category} - ${habitEntry.habitType}`,
        evidence: `Transaction: ${habitEntry.transactionId}, Amount: ${habitEntry.transactionAmount}, Type: ${habitEntry.habitType}`,
        counsel: habitEntry.suggestions,
        full_text: `${habitEntry.spendingPattern}. Frequency: ${habitEntry.frequency}. Risk: ${habitEntry.riskLevel}`,
        metrics: metricsPayload,
        recorded_at: habitEntry.recordedAt,
        previous_habit_id: habitEntry.previousHabitId || null,
        owner: ownerId,
      },
    });
  } catch (error) {
    logger.error("habit-tracker", "Failed to save habit insight", error);
  }

  // Note: Habit snapshots are saved as JSON files in data/habit-snapshots/
  // They are not stored in the database yet
  const snapshotData = {
    snapshotId: snapshot.snapshotId,
    contextData: {
      transactionId: snapshot.transactionId,
      ownerPhone: snapshot.ownerPhone,
      contextTransactions: snapshot.contextTransactions,
      contextHabits: snapshot.contextHabits,
    },
    summaryData: {
      totalDebits: snapshot.totalDebits,
      totalCredits: snapshot.totalCredits,
      netBalance: snapshot.netBalance,
      transactionCount: snapshot.transactionCount,
      topCategories: snapshot.topCategories,
      frequentMerchants: snapshot.frequentMerchants,
      spendingByMedium: snapshot.spendingByMedium,
      averageTransactionSize: snapshot.averageTransactionSize,
      largestTransaction: snapshot.largestTransaction,
      smallestTransaction: snapshot.smallestTransaction,
      mostActiveTime: snapshot.mostActiveTime,
      mostActiveDay: snapshot.mostActiveDay,
      isOverspending: snapshot.isOverspending,
      hasRecurringPayments: snapshot.hasRecurringPayments,
      showsImpulseBuying: snapshot.showsImpulseBuying,
      needsBudgetAlert: snapshot.needsBudgetAlert,
      behaviorSummary: snapshot.behaviorSummary,
      recommendations: snapshot.recommendations,
    },
    owner: ownerId,
  };
  
  // Snapshots are saved as JSON files, not in DB
  // If we want to save them to DB, we'd need a habit_snapshots table
  logger.debug("habit-tracker", "Habit snapshot created", { snapshotId: snapshotData.snapshotId });

  return { habitEntry, snapshot };
}

/**
 * Initializes habit tracking from existing transactions
 * Fetches transactions from database and processes them
 */
export async function initializeHabitsFromTransactions(
  options: HabitTrackerOptions = {},
): Promise<number> {
  const ownerId = options.ownerId ?? (process.env.DEV_USER_ID ? Number(process.env.DEV_USER_ID) : undefined);

  if (!ownerId) {
    throw new Error("ownerId is required for habit initialization");
  }

  console.log("🔄 Initializing habits from existing transactions...");

  // Fetch all transactions from database via loadTransactions (which uses Prisma)
  const normalizedTransactions = await loadTransactions();
  
  if (normalizedTransactions.length === 0) {
    console.log("⚠️  No transactions found");
    return 0;
  }

  // Convert normalized transactions to Transaction format
  const transactions: Transaction[] = normalizedTransactions.map((tx: any) => ({
    ownerPhone: "",  // Not stored in DB
    transactionId: tx.id || "",
    datetime: tx.recordedAt,
    date: tx.eventDate,
    time: tx.eventTime || "00:00:00",
    amount: tx.amount,
    currency: tx.currency || "INR",
    type: tx.direction === "income" ? "credit" : "debit",
    targetParty: tx.meta.targetParty || "",
    description: tx.description,
    category: tx.category,
    isFinancial: true,
    medium: tx.meta.medium || "",
  }));

  console.log(`📊 Processing ${transactions.length} transactions...`);

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
  previousHabits: HabitEntry[],
  ownerId: number,
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
    snapshotId: generateSnapshotId(transaction),
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

  // Snapshot will be synced to database by caller (no file operations)
  return snapshot;
}

/**
/**
 * Loads recent transactions from database API
 */
async function loadRecentTransactions(
  count: number,
  ownerId: number,
): Promise<Transaction[]> {
  try {
    const normalizedTransactions = await loadTransactions();
    
    // Convert to Transaction format and take most recent
    const transactions: Transaction[] = normalizedTransactions
      .slice(-count)  // Take last N transactions
      .map((tx: any) => ({
        ownerPhone: "",
        transactionId: tx.id || "",
        datetime: tx.recordedAt,
        date: tx.eventDate,
        time: tx.eventTime || "00:00:00",
        amount: tx.amount,
        currency: tx.currency || "INR",
        type: (tx.direction === "income" ? "credit" : "debit") as "credit" | "debit" | "income" | "expense",
        targetParty: tx.meta.targetParty || "",
        description: tx.description,
        category: tx.category,
        isFinancial: true,
        medium: tx.meta.medium || "",
      }))
      .reverse(); // Most recent first
    
    return transactions;
  } catch (error) {
    console.error("[habit-tracker] Failed to load transactions:", error);
    return [];
  }
}

/**
 * Loads recent habit entries from database via Prisma
 */
async function loadRecentHabits(count: number, ownerId: number): Promise<HabitEntry[]> {
  try {
    const habits = await prisma.habit_insights.findMany({
      where: { owner: ownerId },
      orderBy: [
        { updated_at: 'desc' },
        { recorded_at: 'desc' },
      ],
      take: count,
    });
    
    // Convert DB format to HabitEntry
    const habitEntries: HabitEntry[] = habits
      .map((habit) => {
        const metrics = (habit.metrics ?? {}) as Record<string, any>;
        const context = extractHabitContext(metrics.context);

        return {
          habitId: habit.habit_id || habit.id.toString(),
          recordedAt: habit.recorded_at?.toISOString() || new Date().toISOString(),
          transactionId: String(context.transactionId ?? ""),
          transactionDate: habit.recorded_at?.toISOString() || "",
          transactionAmount: Number(metrics.averageAmount ?? 0),
          transactionType: "debit",
          targetParty: String(context.targetParty ?? ""),
          category: String(context.category ?? ""),
          spendingPattern: String(metrics.spendingPattern ?? ""),
          frequency: String(metrics.frequency ?? ""),
          averageAmount: Number(metrics.averageAmount ?? 0),
          totalSpent: Number(metrics.totalSpent ?? 0),
          transactionCount: Number(metrics.transactionCount ?? 0),
          habitType: String(metrics.habitType ?? ""),
          riskLevel: String(metrics.riskLevel ?? ""),
          suggestions: habit.counsel || "",
          recentTransactions: String(context.recentTransactions ?? ""),
          previousHabitId: habit.previous_habit_id || String(context.previousHabitId ?? ""),
        } satisfies HabitEntry;
      })
      .reverse();
    
    return habitEntries;
  } catch (error) {
    logger.error("habit-tracker", "Failed to load habits from DB", error);
    return [];
  }
}

function extractHabitContext(candidate: unknown): Record<string, any> {
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return candidate as Record<string, any>;
  }
  return {};
}

/**
 * Generates habit ID
 */
function generateHabitId(transaction: Transaction): string {
  const data = `${transaction.transactionId}-${transaction.date}-${Date.now()}`;
  return createHash("sha1").update(data).digest("hex");
}

/**
 * Generates snapshot ID
 */
function generateSnapshotId(transaction: Transaction): string {
  const data = `snapshot-${transaction.transactionId}-${transaction.date}-${Date.now()}`;
  return createHash("sha1").update(data).digest("hex");
}

/**
 * Serializes habit entry to CSV (not used anymore, kept for compatibility)
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
