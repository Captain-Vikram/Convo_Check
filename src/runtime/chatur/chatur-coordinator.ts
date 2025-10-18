/**
 * Chatur Agent Coordinator
 * 
 * Integrates Chatur with the new query routing system and other agents.
 * Ensures Chatur gets full context from Param's vector database and
 * coordinates with Mill for data retrieval when needed.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { getAgentConfig } from "../../config.js";
import { buildChaturUserContext, type ChaturUserContext } from "./context-builder.js";
import { CHATUR_SYSTEM_PROMPT, isChaturQuery, isMillQuery, type ChaturResponse } from "./chatur-personality.js";
import type { QueryRouting } from "../mill/query-router.js";
import { queryTransactions, type TransactionSummary } from "../mill/transaction-reader.js";
import { runAnalyst, type HabitInsight } from "../param/analyst-agent.js";

export interface ChaturCoachingSession {
  sessionId: string;
  userId: string;
  startedAt: string;
  userContext: ChaturUserContext;
  conversationHistory: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: string;
  }>;
  currentGoals?: string[];
  actionPlan?: {
    immediate: string[];
    shortTerm: string[];
    progress: Record<string, boolean>;
  };
}

/**
 * Main entry point for Chatur coaching
 * Supports the new query routing system
 */
export async function handleCoachingQuery(
  userQuery: string,
  userId: string,
  routing?: QueryRouting,
  options: {
    sessionId?: string;
    csvPath?: string;
  } = {},
): Promise<{
  response: string;
  session: ChaturCoachingSession;
  dataUsed?: {
    transactions?: TransactionSummary;
    insights?: HabitInsight[];
  };
  needsMillData?: boolean;
  millQuery?: string;
}> {
  console.log("[chatur] Handling coaching query:", userQuery);
  
  // Load or create session
  const session = await loadOrCreateSession(userId, options.sessionId);
  
  // Check if we need Mill's data first
  const needsMillData = routing?.dataNeeded.type === "raw_transactions" || 
                        routing?.dataNeeded.type === "mixed";
  
  let transactionData: TransactionSummary | undefined;
  
  if (needsMillData) {
    console.log("[chatur] Fetching transaction data from Mill...");
    // Get data from Mill before coaching
    const queryOptions: any = {};
    if (routing?.dataNeeded.filters?.transactionType) {
      queryOptions.type = routing.dataNeeded.filters.transactionType;
    }
    if (routing?.dataNeeded.filters?.category) {
      queryOptions.category = routing.dataNeeded.filters.category;
    }
    transactionData = await queryTransactions(queryOptions, options.csvPath);
  }
  
  // Generate coaching response with full context
  const response = await generateCoachingResponse(
    userQuery,
    session,
    transactionData,
  );
  
  // Update session
  session.conversationHistory.push(
    { role: "user", content: userQuery, timestamp: new Date().toISOString() },
    { role: "assistant", content: response, timestamp: new Date().toISOString() },
  );
  
  const result: {
    response: string;
    session: ChaturCoachingSession;
    dataUsed?: {
      transactions?: TransactionSummary;
      insights?: HabitInsight[];
    };
    needsMillData?: boolean;
    millQuery?: string;
  } = {
    response,
    session,
  };
  
  if (transactionData) {
    result.dataUsed = { transactions: transactionData };
  }
  
  return result;
}

/**
 * Load existing session or create new one with full context
 */
async function loadOrCreateSession(
  userId: string,
  sessionId?: string,
): Promise<ChaturCoachingSession> {
  // TODO: Implement session persistence
  // For now, create fresh session with full context
  
  console.log("[chatur] Loading user context from vector database...");
  const userContext = await buildChaturUserContext(userId);
  
  return {
    sessionId: sessionId || generateSessionId(),
    userId,
    startedAt: new Date().toISOString(),
    userContext,
    conversationHistory: [],
  };
}

/**
 * Generate coaching response using LLM with full context
 */
async function generateCoachingResponse(
  userQuery: string,
  session: ChaturCoachingSession,
  transactionData?: TransactionSummary,
): Promise<string> {
  const { apiKey, model } = getAgentConfig("agent4"); // Chatur uses agent4 (Coach)
  const provider = createGoogleGenerativeAI({ apiKey });
  const languageModel = provider(model);
  
  // Build comprehensive prompt
  const userPrompt = buildCoachingPrompt(userQuery, session, transactionData);
  
  try {
    const result = await generateText({
      model: languageModel,
      messages: [
        { role: "system", content: CHATUR_SYSTEM_PROMPT },
        ...session.conversationHistory.map(msg => ({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        })),
        { role: "user", content: userPrompt },
      ],
    });
    
    return result.text.trim();
  } catch (error) {
    console.error("[chatur] Failed to generate coaching response:", error);
    return "I'm having trouble processing that right now. Could you rephrase your question?";
  }
}

/**
 * Build comprehensive coaching prompt with all context
 */
function buildCoachingPrompt(
  userQuery: string,
  session: ChaturCoachingSession,
  transactionData?: TransactionSummary,
): string {
  const { userContext } = session;
  const parts: string[] = [];
  
  parts.push(`User Query: "${userQuery}"`);
  parts.push("");
  
  // User Financial Profile
  parts.push("=== USER FINANCIAL PROFILE ===");
  parts.push(`Data Quality: ${userContext.metadata.dataQuality} (${userContext.metadata.totalSnapshots} snapshots)`);
  parts.push(`Analysis Confidence: ${(userContext.metadata.analysisConfidence * 100).toFixed(0)}%`);
  parts.push("");
  
  parts.push("Financial Overview:");
  parts.push(`- Total Transactions: ${userContext.financial.totalTransactions}`);
  parts.push(`- Total Spent: ₹${userContext.financial.totalSpent.toFixed(2)}`);
  parts.push(`- Total Earned: ₹${userContext.financial.totalEarned.toFixed(2)}`);
  parts.push(`- Current Balance: ₹${userContext.financial.currentBalance.toFixed(2)}`);
  parts.push(`- Savings Rate: ${(userContext.financial.savingsRate * 100).toFixed(1)}%`);
  parts.push("");
  
  // Spending Patterns
  if (userContext.spendingPatterns.topCategories.length > 0) {
    parts.push("Top Spending Categories:");
    userContext.spendingPatterns.topCategories.forEach(cat => {
      parts.push(`- ${cat.category}: ₹${cat.amount.toFixed(2)} (${cat.percentage.toFixed(1)}%)`);
    });
    parts.push("");
  }
  
  // Behavioral Insights
  parts.push("=== BEHAVIORAL INSIGHTS ===");
  
  if (Object.values(userContext.behavior.riskFlags).some(flag => flag)) {
    parts.push("Risk Flags:");
    if (userContext.behavior.riskFlags.isOverspending) parts.push("⚠️  Overspending detected");
    if (userContext.behavior.riskFlags.hasImpulseBuying) parts.push("⚠️  Impulse buying pattern");
    if (userContext.behavior.riskFlags.irregularIncome) parts.push("⚠️  Irregular income");
    if (userContext.behavior.riskFlags.lowSavings) parts.push("⚠️  Low savings");
    parts.push("");
  }
  
  if (userContext.behavior.positiveHabits.length > 0) {
    parts.push("Positive Habits:");
    userContext.behavior.positiveHabits.forEach(habit => parts.push(`✓ ${habit}`));
    parts.push("");
  }
  
  if (userContext.behavior.concerningPatterns.length > 0) {
    parts.push("Concerning Patterns:");
    userContext.behavior.concerningPatterns.forEach(pattern => parts.push(`- ${pattern}`));
    parts.push("");
  }
  
  if (userContext.behavior.opportunities.length > 0) {
    parts.push("Opportunities:");
    userContext.behavior.opportunities.forEach(opp => parts.push(`💡 ${opp}`));
    parts.push("");
  }
  
  // Recent Activity
  parts.push("=== RECENT ACTIVITY ===");
  parts.push(`Last 7 Days: ${userContext.recentActivity.last7Days.transactions} transactions, ₹${userContext.recentActivity.last7Days.spent.toFixed(2)} spent`);
  parts.push(`Last 30 Days: ${userContext.recentActivity.last30Days.transactions} transactions, ₹${userContext.recentActivity.last30Days.spent.toFixed(2)} spent`);
  parts.push("");
  
  // Smart Recommendations
  if (userContext.recommendations.immediate.length > 0) {
    parts.push("Recommended Immediate Actions:");
    userContext.recommendations.immediate.forEach(rec => parts.push(`🔴 ${rec}`));
    parts.push("");
  }
  
  if (userContext.recommendations.conversationStarters.length > 0) {
    parts.push("Suggested Conversation Starters:");
    userContext.recommendations.conversationStarters.forEach(q => parts.push(`❓ ${q}`));
    parts.push("");
  }
  
  // Transaction Data (if fetched from Mill)
  if (transactionData) {
    parts.push("=== TRANSACTION DATA (from Mill) ===");
    parts.push(`Period: ${transactionData.dateRange.from} to ${transactionData.dateRange.to}`);
    parts.push(`Transactions: ${transactionData.totalTransactions}`);
    parts.push(`Total Debits: ₹${transactionData.totalDebits.toFixed(2)}`);
    parts.push(`Total Credits: ₹${transactionData.totalCredits.toFixed(2)}`);
    parts.push(`Net: ₹${transactionData.netAmount.toFixed(2)}`);
    
    if (transactionData.transactions.length > 0) {
      parts.push("");
      parts.push("Recent Transactions:");
      transactionData.transactions.slice(0, 5).forEach(tx => {
        parts.push(`- ${tx.date}: ${tx.type === 'debit' ? 'Paid' : 'Received'} ₹${tx.amount}${tx.targetParty ? ` ${tx.type === 'debit' ? 'to' : 'from'} ${tx.targetParty}` : ''}`);
      });
    }
    parts.push("");
  }
  
  // Coaching Instructions
  parts.push("=== YOUR COACHING TASK ===");
  parts.push("Based on the above context:");
  parts.push("1. Understand the user's core concern or question");
  parts.push("2. Provide insights that connect their behavior to outcomes");
  parts.push("3. Ask thoughtful questions to understand root causes");
  parts.push("4. Offer actionable recommendations (immediate, short-term, long-term)");
  parts.push("5. Be empathetic, strategic, and empowering");
  parts.push("");
  parts.push("Remember:");
  parts.push("- You are a COACH, not a data presenter");
  parts.push("- Focus on WHY and HOW, not just WHAT");
  parts.push("- Celebrate progress, acknowledge challenges");
  parts.push("- Guide through questions, not lectures");
  parts.push("- Frame advice as collaboration");
  
  return parts.join("\n");
}

/**
 * Check if query should be redirected to Mill
 */
export function shouldRedirectToMill(query: string): boolean {
  return isMillQuery(query) && !isChaturQuery(query);
}

/**
 * Generate redirect message to Mill
 */
export function generateMillRedirect(query: string): string {
  return `That's a data query - Mill is the expert for pulling specific transaction information! Let me connect you with Mill who can show you exactly what you're looking for.

But once you see the numbers, I'm here if you'd like to explore what they mean for your financial goals. 📊`;
}

/**
 * Proactive coaching trigger (called when Dev processes transactions)
 */
export async function checkCoachingTriggers(
  userId: string,
  newTransaction: {
    amount: number;
    type: string;
    category: string;
    merchant?: string;
  },
): Promise<{ shouldTrigger: boolean; message?: string }> {
  const context = await buildChaturUserContext(userId);
  
  // Trigger 1: Budget threshold crossed
  const topCategory = context.spendingPatterns.topCategories[0];
  if (topCategory && topCategory.category === newTransaction.category) {
    const categoryPercentage = topCategory.percentage;
    if (categoryPercentage > 40) {
      return {
        shouldTrigger: true,
        message: `I noticed you just spent ₹${newTransaction.amount} on ${newTransaction.category}. This category is already ${categoryPercentage.toFixed(0)}% of your spending. Would you like to discuss your ${newTransaction.category} budget?`,
      };
    }
  }
  
  // Trigger 2: Overspending risk
  if (context.behavior.riskFlags.isOverspending && newTransaction.type === "expense") {
    return {
      shouldTrigger: true,
      message: `Quick check-in: I see you're spending more than you're earning lately. This ₹${newTransaction.amount} expense adds to the pattern. Want to pause and create a quick action plan together?`,
    };
  }
  
  // Trigger 3: Impulse buying pattern (if 3+ transactions in short period)
  if (context.behavior.riskFlags.hasImpulseBuying) {
    const recentCount = context.recentActivity.last7Days.transactions;
    if (recentCount >= 10) {
      return {
        shouldTrigger: true,
        message: `I'm noticing frequent small purchases this week (${recentCount} transactions). This could be impulse buying. Would you be open to trying the 24-hour rule for non-essentials?`,
      };
    }
  }
  
  return { shouldTrigger: false };
}

// Helper
function generateSessionId(): string {
  return `chatur_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
