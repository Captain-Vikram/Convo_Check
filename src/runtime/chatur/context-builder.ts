/**
 * Chatur Context Builder
 * 
 * Loads and prepares comprehensive user context from Param's vector database
 * for intelligent coaching conversations.
 * 
 * Provides:
 * - User financial profile (spending patterns, income stability)
 * - Historical habit insights (progression over time)
 * - Transaction patterns (categories, merchants, timing)
 * - Behavioral indicators (risk flags, opportunities)
 * - Smart recommendations based on full context
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HabitSnapshot } from "../param/habit-tracker.js";
import type { HabitInsight } from "../param/analyst-agent.js";
import type { NormalizedTransaction } from "../dev/transaction-normalizer.js";

const DATA_DIR = join(process.cwd(), "data");
const SNAPSHOTS_DIR = join(DATA_DIR, "habit-snapshots");

/**
 * Comprehensive user context for Chatur coaching
 */
export interface ChaturUserContext {
  // User Profile
  userId: string;
  profileGeneratedAt: string;
  
  // Financial Overview
  financial: {
    totalTransactions: number;
    totalSpent: number;
    totalEarned: number;
    currentBalance: number;
    averageTransactionSize: number;
    savingsRate: number;
  };
  
  // Spending Patterns
  spendingPatterns: {
    topCategories: Array<{ category: string; amount: number; percentage: number }>;
    frequentMerchants: Array<{ merchant: string; visits: number; totalSpent: number }>;
    spendingByTime: {
      mostActiveTime: string;
      mostActiveDay: string;
      peakSpendingHours: string[];
    };
    monthlyTrends: {
      currentMonth: number;
      lastMonth: number;
      trend: "increasing" | "decreasing" | "stable";
      changePercentage: number;
    };
  };
  
  // Behavioral Insights
  behavior: {
    riskFlags: {
      isOverspending: boolean;
      hasImpulseBuying: boolean;
      irregularIncome: boolean;
      lowSavings: boolean;
    };
    positiveHabits: string[];
    concerningPatterns: string[];
    opportunities: string[];
  };
  
  // Historical Context (for progression tracking)
  history: {
    habitProgression: Array<{
      date: string;
      habitType: string;
      pattern: string;
      suggestion: string;
    }>;
    recentInsights: HabitInsight[];
    keyMilestones: Array<{
      date: string;
      event: string;
      impact: string;
    }>;
  };
  
  // Transaction Details (recent activity)
  recentActivity: {
    last7Days: {
      transactions: number;
      spent: number;
      earned: number;
    };
    last30Days: {
      transactions: number;
      spent: number;
      earned: number;
    };
    significantTransactions: Array<{
      id: string;
      date: string;
      amount: number;
      type: string;
      category: string;
      merchant?: string;
    }>;
  };
  
  // Smart Recommendations
  recommendations: {
    immediate: string[]; // Urgent actions
    shortTerm: string[]; // This week/month
    longTerm: string[]; // Overall strategy
    conversationStarters: string[]; // Questions Chatur should ask
  };
  
  // Contextual Metadata
  metadata: {
    totalSnapshots: number;
    oldestSnapshot: string;
    newestSnapshot: string;
    dataQuality: "excellent" | "good" | "limited" | "insufficient";
    analysisConfidence: number; // 0-1
  };
}

/**
 * Builds comprehensive user context from Param's vector database
 */
export async function buildChaturUserContext(
  userId: string,
  options: {
    includeFullHistory?: boolean;
    minConfidence?: number;
    maxSnapshots?: number;
  } = {},
): Promise<ChaturUserContext> {
  const { includeFullHistory = false, maxSnapshots = 50 } = options;
  
  // Load all habit snapshots
  const snapshots = await loadHabitSnapshots(userId, maxSnapshots);
  
  if (snapshots.length === 0) {
    return createEmptyContext(userId);
  }
  
  // Load habit insights from Param
  const insights = await loadHabitInsights();
  
  // Aggregate financial data
  const financial = calculateFinancialOverview(snapshots);
  
  // Extract spending patterns
  const spendingPatterns = analyzeSpendingPatterns(snapshots);
  
  // Identify behavioral insights
  const behavior = extractBehavioralInsights(snapshots, insights);
  
  // Build historical progression
  const history = buildHistoricalContext(snapshots, insights, includeFullHistory);
  
  // Analyze recent activity
  const recentActivity = analyzeRecentActivity(snapshots);
  
  // Generate smart recommendations
  const recommendations = generateSmartRecommendations(
    financial,
    spendingPatterns,
    behavior,
    insights,
  );
  
  // Calculate metadata
  const metadata = calculateMetadata(snapshots);
  
  return {
    userId,
    profileGeneratedAt: new Date().toISOString(),
    financial,
    spendingPatterns,
    behavior,
    history,
    recentActivity,
    recommendations,
    metadata,
  };
}

/**
 * Loads habit snapshots from vector database
 */
async function loadHabitSnapshots(
  userId: string,
  maxSnapshots: number,
): Promise<HabitSnapshot[]> {
  try {
    const files = await readdir(SNAPSHOTS_DIR);
    const jsonFiles = files.filter(f => f.endsWith(".json"));
    
    // Sort by modification time (most recent first)
    const snapshots: HabitSnapshot[] = [];
    
    for (const file of jsonFiles.slice(0, maxSnapshots)) {
      const content = await readFile(join(SNAPSHOTS_DIR, file), "utf8");
      const snapshot = JSON.parse(content) as HabitSnapshot;
      
      // Filter by userId if needed
      if (!userId || snapshot.ownerPhone === userId) {
        snapshots.push(snapshot);
      }
    }
    
    // Sort by creation time
    snapshots.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    
    return snapshots;
  } catch (error) {
    console.warn("[chatur-context] Failed to load snapshots:", error);
    return [];
  }
}

/**
 * Loads habit insights from Param's analysis
 */
async function loadHabitInsights(): Promise<HabitInsight[]> {
  try {
    const habitsPath = join(DATA_DIR, "habits.csv");
    const content = await readFile(habitsPath, "utf8");
    const lines = content.trim().split("\n");
    
    if (lines.length <= 1) return [];
    
    // Parse CSV (skip header)
    const insights: HabitInsight[] = [];
    
    // For now, return empty array - proper CSV parsing needed
    // TODO: Parse habits.csv properly
    
    return insights;
  } catch (error) {
    console.warn("[chatur-context] Failed to load insights:", error);
    return [];
  }
}

/**
 * Calculates financial overview from snapshots
 */
function calculateFinancialOverview(snapshots: HabitSnapshot[]) {
  if (snapshots.length === 0) {
    return {
      totalTransactions: 0,
      totalSpent: 0,
      totalEarned: 0,
      currentBalance: 0,
      averageTransactionSize: 0,
      savingsRate: 0,
    };
  }
  
  // Use most recent snapshot for current state
  const latest = snapshots[0]!;
  
  // Aggregate across all snapshots for totals
  const totalSpent = snapshots.reduce((sum, s) => sum + s.totalDebits, 0) / snapshots.length;
  const totalEarned = snapshots.reduce((sum, s) => sum + s.totalCredits, 0) / snapshots.length;
  
  return {
    totalTransactions: latest.transactionCount,
    totalSpent,
    totalEarned,
    currentBalance: latest.netBalance,
    averageTransactionSize: latest.averageTransactionSize,
    savingsRate: totalEarned > 0 ? (totalEarned - totalSpent) / totalEarned : 0,
  };
}

/**
 * Analyzes spending patterns across snapshots
 */
function analyzeSpendingPatterns(snapshots: HabitSnapshot[]) {
  if (snapshots.length === 0) {
    return createEmptySpendingPatterns();
  }
  
  const latest = snapshots[0]!;
  
  // Aggregate top categories across all snapshots
  const categoryMap = new Map<string, { amount: number; count: number }>();
  
  snapshots.forEach(snapshot => {
    snapshot.topCategories?.forEach(cat => {
      const existing = categoryMap.get(cat.category) || { amount: 0, count: 0 };
      categoryMap.set(cat.category, {
        amount: existing.amount + cat.amount,
        count: existing.count + cat.count,
      });
    });
  });
  
  const totalSpent = Array.from(categoryMap.values())
    .reduce((sum, cat) => sum + cat.amount, 0);
  
  const topCategories = Array.from(categoryMap.entries())
    .map(([category, data]) => ({
      category,
      amount: data.amount,
      percentage: totalSpent > 0 ? (data.amount / totalSpent) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);
  
  // Extract merchant data
  const frequentMerchants = (latest.frequentMerchants || []).map(m => ({
    merchant: m.merchant,
    visits: m.count,
    totalSpent: m.amount,
  }));
  
  // Time-based patterns
  const spendingByTime = {
    mostActiveTime: latest.mostActiveTime || "unknown",
    mostActiveDay: latest.mostActiveDay || "unknown",
    peakSpendingHours: extractPeakHours(snapshots),
  };
  
  // Monthly trends
  const monthlyTrends = calculateMonthlyTrends(snapshots);
  
  return {
    topCategories,
    frequentMerchants,
    spendingByTime,
    monthlyTrends,
  };
}

/**
 * Extracts behavioral insights and risk flags
 */
function extractBehavioralInsights(
  snapshots: HabitSnapshot[],
  insights: HabitInsight[],
) {
  const latest = snapshots[0] || createEmptySnapshot();
  
  const riskFlags = {
    isOverspending: latest.isOverspending || false,
    hasImpulseBuying: latest.showsImpulseBuying || false,
    irregularIncome: detectIrregularIncome(snapshots),
    lowSavings: latest.netBalance < 0,
  };
  
  const positiveHabits: string[] = [];
  const concerningPatterns: string[] = [];
  const opportunities: string[] = [];
  
  // Analyze from snapshots
  if (latest.hasRecurringPayments) {
    positiveHabits.push("Consistent with recurring payments");
  }
  
  if (riskFlags.isOverspending) {
    concerningPatterns.push("Spending exceeds income");
    opportunities.push("Create a monthly budget to track expenses");
  }
  
  if (riskFlags.hasImpulseBuying) {
    concerningPatterns.push("Frequent small impulse purchases");
    opportunities.push("Implement 24-hour rule for non-essential purchases");
  }
  
  if (!riskFlags.irregularIncome && !riskFlags.isOverspending) {
    positiveHabits.push("Stable income and controlled spending");
  }
  
  return {
    riskFlags,
    positiveHabits,
    concerningPatterns,
    opportunities,
  };
}

/**
 * Builds historical progression context
 */
function buildHistoricalContext(
  snapshots: HabitSnapshot[],
  insights: HabitInsight[],
  includeFull: boolean,
) {
  const habitProgression = snapshots
    .slice(0, includeFull ? snapshots.length : 10)
    .map(s => {
      const habit = s.contextHabits?.[0];
      return {
        date: s.createdAt,
        habitType: habit?.habitType || "unknown",
        pattern: habit?.spendingPattern || "unknown",
        suggestion: habit?.suggestions || "",
      };
    });
  
  const recentInsights = insights.slice(0, 5);
  
  const keyMilestones = identifyKeyMilestones(snapshots);
  
  return {
    habitProgression,
    recentInsights,
    keyMilestones,
  };
}

/**
 * Analyzes recent activity (last 7 and 30 days)
 */
function analyzeRecentActivity(snapshots: HabitSnapshot[]) {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  
  const recent7 = snapshots.filter(s => new Date(s.createdAt) >= sevenDaysAgo);
  const recent30 = snapshots.filter(s => new Date(s.createdAt) >= thirtyDaysAgo);
  
  const last7Days = {
    transactions: recent7.reduce((sum, s) => sum + s.transactionCount, 0),
    spent: recent7.reduce((sum, s) => sum + s.totalDebits, 0),
    earned: recent7.reduce((sum, s) => sum + s.totalCredits, 0),
  };
  
  const last30Days = {
    transactions: recent30.reduce((sum, s) => sum + s.transactionCount, 0),
    spent: recent30.reduce((sum, s) => sum + s.totalDebits, 0),
    earned: recent30.reduce((sum, s) => sum + s.totalCredits, 0),
  };
  
  // Find significant transactions
  const significantTransactions = snapshots
    .slice(0, 10)
    .flatMap(s => s.contextTransactions)
    .filter(t => t.amount > 1000) // Threshold for "significant"
    .map(t => ({
      id: t.transactionId,
      date: t.date,
      amount: t.amount,
      type: t.type,
      category: t.category,
      merchant: t.targetParty,
    }))
    .slice(0, 5);
  
  return {
    last7Days,
    last30Days,
    significantTransactions,
  };
}

/**
 * Generates smart recommendations based on full context
 */
function generateSmartRecommendations(
  financial: ReturnType<typeof calculateFinancialOverview>,
  patterns: ReturnType<typeof analyzeSpendingPatterns>,
  behavior: ReturnType<typeof extractBehavioralInsights>,
  insights: HabitInsight[],
) {
  const immediate: string[] = [];
  const shortTerm: string[] = [];
  const longTerm: string[] = [];
  const conversationStarters: string[] = [];
  
  // Immediate actions (urgent)
  if (behavior.riskFlags.isOverspending) {
    immediate.push("Review and pause non-essential spending this week");
    conversationStarters.push("I noticed you're spending more than earning. What's driving this?");
  }
  
  if (financial.currentBalance < 0) {
    immediate.push("Focus on income-generating activities to balance out");
    conversationStarters.push("Your balance is negative. Do you have income expected soon?");
  }
  
  // Short-term (this week/month)
  if (behavior.riskFlags.hasImpulseBuying) {
    shortTerm.push("Try the 24-hour rule: wait before making non-essential purchases");
  }
  
  const topCategory = patterns.topCategories[0];
  if (topCategory && topCategory.percentage > 40) {
    shortTerm.push(`Set a budget for ${topCategory.category} - it's ${topCategory.percentage.toFixed(0)}% of your spending`);
    conversationStarters.push(`You spend a lot on ${topCategory.category}. Is this intentional or would you like to reduce it?`);
  }
  
  // Long-term strategy
  if (financial.savingsRate < 0.1) {
    longTerm.push("Build an emergency fund: aim to save 10-15% of income");
  }
  
  if (behavior.riskFlags.irregularIncome) {
    longTerm.push("Create a buffer for irregular income months");
    conversationStarters.push("Your income varies. How do you plan for lean months?");
  }
  
  // Always add positive conversation starters
  if (!behavior.riskFlags.isOverspending && financial.savingsRate > 0) {
    conversationStarters.push("You're doing well with savings! What's your next financial goal?");
  }
  
  return {
    immediate,
    shortTerm,
    longTerm,
    conversationStarters,
  };
}

// Helper functions

function createEmptyContext(userId: string): ChaturUserContext {
  return {
    userId,
    profileGeneratedAt: new Date().toISOString(),
    financial: {
      totalTransactions: 0,
      totalSpent: 0,
      totalEarned: 0,
      currentBalance: 0,
      averageTransactionSize: 0,
      savingsRate: 0,
    },
    spendingPatterns: createEmptySpendingPatterns(),
    behavior: {
      riskFlags: {
        isOverspending: false,
        hasImpulseBuying: false,
        irregularIncome: false,
        lowSavings: false,
      },
      positiveHabits: [],
      concerningPatterns: ["Insufficient data for analysis"],
      opportunities: ["Start logging transactions to build your profile"],
    },
    history: {
      habitProgression: [],
      recentInsights: [],
      keyMilestones: [],
    },
    recentActivity: {
      last7Days: { transactions: 0, spent: 0, earned: 0 },
      last30Days: { transactions: 0, spent: 0, earned: 0 },
      significantTransactions: [],
    },
    recommendations: {
      immediate: ["Log your first transaction to start tracking"],
      shortTerm: [],
      longTerm: ["Build a consistent tracking habit"],
      conversationStarters: ["What are your main financial goals right now?"],
    },
    metadata: {
      totalSnapshots: 0,
      oldestSnapshot: "",
      newestSnapshot: "",
      dataQuality: "insufficient",
      analysisConfidence: 0,
    },
  };
}

function createEmptySpendingPatterns() {
  return {
    topCategories: [],
    frequentMerchants: [],
    spendingByTime: {
      mostActiveTime: "unknown",
      mostActiveDay: "unknown",
      peakSpendingHours: [],
    },
    monthlyTrends: {
      currentMonth: 0,
      lastMonth: 0,
      trend: "stable" as const,
      changePercentage: 0,
    },
  };
}

function createEmptySnapshot(): HabitSnapshot {
  return {
    snapshotId: "",
    createdAt: new Date().toISOString(),
    transactionId: "",
    ownerPhone: "",
    contextTransactions: [],
    contextHabits: [],
    totalDebits: 0,
    totalCredits: 0,
    netBalance: 0,
    transactionCount: 0,
    topCategories: [],
    frequentMerchants: [],
    spendingByMedium: [],
    averageTransactionSize: 0,
    largestTransaction: 0,
    smallestTransaction: 0,
    mostActiveTime: "unknown",
    mostActiveDay: "unknown",
    isOverspending: false,
    hasRecurringPayments: false,
    showsImpulseBuying: false,
    needsBudgetAlert: false,
    behaviorSummary: "",
    recommendations: [],
  };
}

function extractPeakHours(snapshots: HabitSnapshot[]): string[] {
  // Simplified - would analyze transaction times
  return ["14:00-16:00", "19:00-21:00"];
}

function calculateMonthlyTrends(snapshots: HabitSnapshot[]) {
  if (snapshots.length < 2) {
    return {
      currentMonth: 0,
      lastMonth: 0,
      trend: "stable" as const,
      changePercentage: 0,
    };
  }
  
  const now = new Date();
  const currentMonth = now.getMonth();
  const lastMonth = currentMonth === 0 ? 11 : currentMonth - 1;
  
  const currentMonthSnapshots = snapshots.filter(s => 
    new Date(s.createdAt).getMonth() === currentMonth
  );
  const lastMonthSnapshots = snapshots.filter(s => 
    new Date(s.createdAt).getMonth() === lastMonth
  );
  
  const currentSpend = currentMonthSnapshots.reduce((sum, s) => sum + s.totalDebits, 0);
  const lastSpend = lastMonthSnapshots.reduce((sum, s) => sum + s.totalDebits, 0);
  
  const changePercentage = lastSpend > 0 
    ? ((currentSpend - lastSpend) / lastSpend) * 100 
    : 0;
  
  const trend: "increasing" | "decreasing" | "stable" = 
    changePercentage > 10 ? "increasing" :
    changePercentage < -10 ? "decreasing" : "stable";
  
  return {
    currentMonth: currentSpend,
    lastMonth: lastSpend,
    trend,
    changePercentage,
  };
}

function detectIrregularIncome(snapshots: HabitSnapshot[]): boolean {
  if (snapshots.length < 3) return false;
  
  const incomes = snapshots.map(s => s.totalCredits);
  const avgIncome = incomes.reduce((sum, i) => sum + i, 0) / incomes.length;
  
  // Check if income varies by more than 30%
  const hasHighVariation = incomes.some(i => 
    Math.abs(i - avgIncome) / avgIncome > 0.3
  );
  
  return hasHighVariation;
}

function identifyKeyMilestones(snapshots: HabitSnapshot[]) {
  const milestones: Array<{ date: string; event: string; impact: string }> = [];
  
  // Find first positive balance
  const firstPositive = snapshots
    .slice()
    .reverse()
    .find(s => s.netBalance > 0);
  
  if (firstPositive) {
    milestones.push({
      date: firstPositive.createdAt,
      event: "First positive balance",
      impact: "Started earning more than spending",
    });
  }
  
  // Find largest single transaction
  const maxTransaction = Math.max(...snapshots.map(s => s.largestTransaction));
  const largestTx = snapshots.find(s => s.largestTransaction === maxTransaction);
  
  if (largestTx && maxTransaction > 5000) {
    milestones.push({
      date: largestTx.createdAt,
      event: `Largest transaction: ₹${maxTransaction}`,
      impact: "Significant expense - worth reviewing",
    });
  }
  
  return milestones;
}

function calculateMetadata(snapshots: HabitSnapshot[]) {
  if (snapshots.length === 0) {
    return {
      totalSnapshots: 0,
      oldestSnapshot: "",
      newestSnapshot: "",
      dataQuality: "insufficient" as const,
      analysisConfidence: 0,
    };
  }
  
  const sorted = snapshots.slice().sort((a, b) => 
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  
  const quality: "excellent" | "good" | "limited" | "insufficient" = 
    snapshots.length >= 20 ? "excellent" :
    snapshots.length >= 10 ? "good" :
    snapshots.length >= 5 ? "limited" : "insufficient";
  
  const confidence = Math.min(snapshots.length / 20, 1);
  
  return {
    totalSnapshots: snapshots.length,
    oldestSnapshot: sorted[0]!.createdAt,
    newestSnapshot: sorted[sorted.length - 1]!.createdAt,
    dataQuality: quality,
    analysisConfidence: confidence,
  };
}
