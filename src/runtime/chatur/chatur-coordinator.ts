/**
 * Chatur Agent Coordinator
 * 
 * Integrates Chatur with the new query routing system and other agents.
 * Ensures Chatur gets full context from Param's vector database and
 * coordinates with Mill for data retrieval when needed.
 * 
 * Enhanced with factual answer lookup for educational coaching.
 */

import { generateText } from "ai";
import { getAgentConfig, createLanguageModel } from "../../config.js";
import { buildChaturUserContext, type ChaturUserContext } from "./context-builder.js";
import { CHATUR_SYSTEM_PROMPT, isChaturQuery, isMillQuery, type ChaturResponse } from "./chatur-personality.js";
import type { QueryRouting } from "../mill/query-router.js";
import { queryTransactions, type TransactionSummary } from "../mill/transaction-reader.js";
import { runAnalyst, type HabitInsight } from "../param/analyst-agent.js";
import { searchWeb, formatSearchResults, type WebSearchResult } from "../../tools/web-search.js";
import {
  calculateSavingsGoal,
  calculateBudgetAllocation,
  calculateCompoundInterest,
  checkAffordability,
  calculateDailyBudget,
  formatCurrency as formatCurrencyCalc,
  formatPercentage,
  type SavingsGoalCalculation,
  type AffordabilityCheck,
} from "../../tools/financial-calculator.js";
import {
  analyzeExpenses,
  analyzeSpendingPatterns,
  getVendorSpend,
  formatCurrency,
  formatPercentage as formatPercent,
  type ExpenseAnalysis,
  type SpendingPattern,
} from "../../tools/expense-analyzer.js";
import {
  assessPurchase,
  suggestCuts,
  quickAffordabilityCheck,
  type PurchaseAssessment,
  type CutSuggestion,
  type AffordabilityOptions,
} from "../../tools/decision-tools.js";

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
 * Supports the new query routing system and factual answer lookup
 */
export async function handleCoachingQuery(
  userQuery: string,
  userId: string,
  routing?: QueryRouting,
  options: {
    sessionId?: string;
    csvPath?: string;
    enableFactualLookup?: boolean;
  } = {},
): Promise<{
  response: string;
  session: ChaturCoachingSession;
  dataUsed?: {
    transactions?: TransactionSummary;
    insights?: HabitInsight[];
    factualAnswers?: WebSearchResult;
  };
  needsMillData?: boolean;
  millQuery?: string;
}> {
  console.log("[chatur] Handling coaching query:", userQuery);
  
  // Load or create session
  const session = await loadOrCreateSession(userId, options.sessionId);
  
  // Check if query needs financial calculations
  let calculationResult: string | undefined;
  if (needsFinancialCalculation(userQuery)) {
    const calcParams = extractCalculationParams(userQuery, session.userContext);
    if (calcParams.type) {
      console.log(`[chatur] 🧮 Performing ${calcParams.type} calculation`);
      calculationResult = performCalculation(calcParams.type, calcParams.params);
      console.log(`[chatur] ✅ Calculation complete`);
    }
  }
  
  // Check if query needs factual clarification
  const enableFactualLookup = options.enableFactualLookup !== false; // Default true
  let factualAnswers: WebSearchResult | undefined;
  
  if (enableFactualLookup && shouldLookupFactualAnswer(userQuery)) {
    const conceptToLookup = extractFinancialConcept(userQuery);
    if (conceptToLookup) {
      console.log(`[chatur] 📚 Looking up factual answer for concept: "${conceptToLookup}"`);
      try {
        factualAnswers = await searchWeb(conceptToLookup, 3);
        if (factualAnswers.totalResults > 0) {
          console.log(`[chatur] ✅ Found ${factualAnswers.totalResults} factual answers`);
        }
      } catch (error) {
        console.error("[chatur] ❌ Factual lookup failed:", error);
      }
    }
  }
  
  // Check if we need Mill's data first
  const needsMillData = routing?.dataNeeded.type === "raw_transactions" || 
                        routing?.dataNeeded.type === "mixed";
  
  let transactionData: TransactionSummary | undefined;
  let expenseAnalysis: ExpenseAnalysis | undefined;
  let purchaseAssessment: PurchaseAssessment | undefined;
  
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
  
  // ENHANCED: Always analyze expenses for smart coaching
  console.log("[chatur] 📊 Analyzing expenses for detailed insights...");
  try {
    // Load all transactions for comprehensive analysis
    const { readTransactionsFromCSV } = await import("../mill/transaction-reader.js");
    const csvPath = options.csvPath || "./data/transactions.csv";
    const allTransactions = await readTransactionsFromCSV(csvPath);
    
    // Analyze expenses with vendor detection
    expenseAnalysis = analyzeExpenses(allTransactions);
    console.log(`[chatur] ✅ Analyzed ${allTransactions.length} transactions`);
    console.log(`[chatur] 💰 Monthly: Income ₹${expenseAnalysis.monthlyIncome.toFixed(0)}, Expenses ₹${expenseAnalysis.monthlyExpenses.toFixed(0)}, Savings ₹${expenseAnalysis.netSavings.toFixed(0)}`);
    
    // Check if query is about purchasing something
    const purchaseMatch = userQuery.match(/buy|purchase|afford|get/i);
    const amountMatch = userQuery.match(/₹?(\d+(?:,\d+)*)/);
    
    if (purchaseMatch && amountMatch && amountMatch[1] && expenseAnalysis.monthlyIncome > 0) {
      const purchaseAmount = parseInt(amountMatch[1].replace(/,/g, ""));
      console.log(`[chatur] 🛒 Assessing purchase of ₹${purchaseAmount}...`);
      
      purchaseAssessment = assessPurchase(allTransactions, {
        purchaseAmount,
        timeframeMonths: 1,
        currentSavings: expenseAnalysis.netSavings > 0 ? expenseAnalysis.netSavings : 0,
        minSavingsBuffer: 0.1,
      });
      
      console.log(`[chatur] ✅ Assessment: ${purchaseAssessment.recommendation} (score: ${purchaseAssessment.affordabilityScore})`);
    }
  } catch (error) {
    console.error("[chatur] ❌ Expense analysis failed:", error);
  }
  
  // Generate coaching response with full context
  const response = await generateCoachingResponse(
    userQuery,
    session,
    transactionData,
    factualAnswers,
    calculationResult,
    expenseAnalysis,
    purchaseAssessment,
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
      factualAnswers?: WebSearchResult;
    };
    needsMillData?: boolean;
    millQuery?: string;
  } = {
    response,
    session,
  };
  
  // Include data sources used in response
  if (transactionData || session.userContext.history.recentInsights.length > 0 || factualAnswers) {
    result.dataUsed = {};
    if (transactionData) {
      result.dataUsed.transactions = transactionData;
    }
    if (session.userContext.history.recentInsights.length > 0) {
      result.dataUsed.insights = session.userContext.history.recentInsights;
    }
    if (factualAnswers) {
      result.dataUsed.factualAnswers = factualAnswers;
    }
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
  factualAnswers?: WebSearchResult,
  calculationResult?: string,
  expenseAnalysis?: ExpenseAnalysis,
  purchaseAssessment?: PurchaseAssessment,
): Promise<string> {
  const config = getAgentConfig("agent4"); // Chatur uses agent4 (Coach)
  const languageModel = createLanguageModel(config);
  
  // Enhanced system prompt with factual answer guidance
  const enhancedSystemPrompt = CHATUR_SYSTEM_PROMPT + `

**USING FACTUAL INFORMATION (When Available):**

When factual reference information is provided in your context:
1. **Educate First**: Start by explaining the concept using the factual definition
2. **Personalize Second**: Connect the concept to their specific financial situation
3. **Coach Third**: Provide actionable guidance based on both the concept and their data

Example - If user asks "What is an emergency fund?" and factual info is provided:
"Great question! An emergency fund is [use factual definition to explain]. Now, looking at your situation - with irregular gig income and current savings of ₹2,340, building an emergency fund should be your top priority. Here's why it's especially important for you: [connect to their risk flags]. Let's start with a realistic goal: ₹500/week in good income weeks..."

**If NO factual information is provided** (search returned nothing):
- Answer confidently from your coaching knowledge
- Don't mention that you searched or couldn't find information
- Provide the same quality coaching experience
- Focus on their specific situation

Your coaching should ALWAYS feel personalized and insightful, whether you have factual references or not.`;

  // Build comprehensive prompt with user context, calculations, and factual answers
  const userPrompt = buildCoachingPrompt(userQuery, session, transactionData, factualAnswers, calculationResult, expenseAnalysis, purchaseAssessment);
  
  try {
    const result = await generateText({
      model: languageModel,
      messages: [
        { role: "system", content: enhancedSystemPrompt },
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
 * Build comprehensive coaching prompt with user context
 */
function buildCoachingPrompt(
  userQuery: string,
  session: ChaturCoachingSession,
  transactionData?: TransactionSummary,
  factualAnswers?: WebSearchResult,
  calculationResult?: string,
  expenseAnalysis?: ExpenseAnalysis,
  purchaseAssessment?: PurchaseAssessment,
): string {
  const { userContext } = session;
  const parts: string[] = [];
  
  parts.push(`User Query: "${userQuery}"`);
  parts.push("");
  
  // Include calculation results if available
  if (calculationResult) {
    parts.push("=== ACCURATE CALCULATION RESULT ===");
    parts.push(calculationResult);
    parts.push("");
    parts.push("IMPORTANT: Use these EXACT calculated numbers in your response. These are mathematically accurate.");
    parts.push("Your job is to explain what these numbers mean for the user's situation and provide actionable coaching.");
    parts.push("");
  }
  
  // Include factual answers if available
  if (factualAnswers && factualAnswers.totalResults > 0) {
    parts.push("=== FACTUAL REFERENCE (Use this to educate the user) ===");
    parts.push(formatSearchResults(factualAnswers));
    parts.push("");
    parts.push("IMPORTANT: Use the above factual definition to educate the user, then apply it to their specific situation based on the financial profile below.");
    parts.push("");
  }
  
  // Param's Vector Database Insights (As documented in coach.ts)
  if (userContext.history.recentInsights && userContext.history.recentInsights.length > 0) {
    parts.push("=== PARAM'S HABIT INSIGHTS (Vector Database) ===");
    parts.push("These insights were identified by Param agent through transaction pattern analysis:");
    parts.push("");
    
    userContext.history.recentInsights.forEach((insight, index) => {
      parts.push(`Insight ${index + 1}:`);
      parts.push(`  Habit Label: ${insight.habitLabel}`);
      parts.push(`  Evidence: ${insight.evidence}`);
      if (insight.counsel) {
        parts.push(`  Param's Counsel: ${insight.counsel}`);
      }
      parts.push("");
    });
    
    parts.push("NOTE: Use these insights as foundation for your coaching. They represent Param's analysis of spending patterns.");
    parts.push("");
  }
  
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
  
  // ENHANCED: Detailed Expense Analysis
  if (expenseAnalysis) {
    parts.push("=== 📊 DETAILED EXPENSE ANALYSIS ===");
    parts.push(`Monthly Income: ${formatCurrency(expenseAnalysis.monthlyIncome)}`);
    parts.push(`Monthly Expenses: ${formatCurrency(expenseAnalysis.monthlyExpenses)}`);
    parts.push(`Monthly Savings: ${formatCurrency(expenseAnalysis.netSavings)} (${formatPercent(expenseAnalysis.savingsRate)})`);
    parts.push("");
    
    if (expenseAnalysis.categoryBreakdowns.length > 0) {
      parts.push("Category Breakdown with Vendor Details:");
      expenseAnalysis.categoryBreakdowns.slice(0, 5).forEach(cat => {
        parts.push(`\n${cat.category}: ${formatCurrency(cat.total)} (${formatPercent(cat.percentage)})`);
        parts.push(`  Transactions: ${cat.transactionCount}, Avg: ${formatCurrency(cat.averagePerTransaction)}`);
        
        // Show top vendors in this category
        if (cat.vendors.length > 0) {
          const topVendors = cat.vendors.slice(0, 3);
          parts.push(`  Top vendors: ${topVendors.map(v => `${v.vendor} ${formatCurrency(v.amount)}`).join(", ")}`);
        }
      });
      parts.push("");
    }
    
    // Income sources
    if (expenseAnalysis.incomeSources.length > 0) {
      parts.push("Income Sources:");
      expenseAnalysis.incomeSources.forEach(src => {
        parts.push(`- ${src.source}: ${formatCurrency(src.total)} (${src.transactionCount} transactions, avg ${formatCurrency(src.averageAmount)})`);
      });
      parts.push("");
    }
    
    // High spend categories (opportunities for savings)
    if (expenseAnalysis.highSpendCategories.length > 0) {
      parts.push("⚠️ HIGH SPEND CATEGORIES (>30% of expenses):");
      expenseAnalysis.highSpendCategories.forEach(cat => {
        parts.push(`- ${cat}`);
      });
      parts.push("These are PRIME opportunities for cost reduction!");
      parts.push("");
    }
    
    // Top vendors across all categories
    if (expenseAnalysis.topVendors.length > 0) {
      parts.push("Top Vendors Overall:");
      expenseAnalysis.topVendors.slice(0, 5).forEach(v => {
        parts.push(`- ${v.vendor}: ${formatCurrency(v.amount)} (${v.count} transactions)`);
      });
      parts.push("");
    }
  }
  
  // ENHANCED: Purchase Affordability Assessment
  if (purchaseAssessment) {
    parts.push("=== 🛒 PURCHASE AFFORDABILITY ASSESSMENT ===");
    parts.push(`Recommendation: ${purchaseAssessment.recommendation.toUpperCase()}`);
    parts.push(`Affordability Score: ${purchaseAssessment.affordabilityScore}/100`);
    parts.push(`Impact on Budget: ${purchaseAssessment.impactOnBudget.toFixed(1)}% of monthly income`);
    parts.push("");
    
    parts.push("Required Savings:");
    parts.push(`- Per Day: ${formatCurrency(purchaseAssessment.requiredSavings.perDay)}`);
    parts.push(`- Per Week: ${formatCurrency(purchaseAssessment.requiredSavings.perWeek)}`);
    parts.push(`- Per Month: ${formatCurrency(purchaseAssessment.requiredSavings.perMonth)}`);
    parts.push("");
    
    parts.push(`Analysis: ${purchaseAssessment.reason}`);
    parts.push("");
    
    // Specific cut-down suggestions
    if (purchaseAssessment.suggestedCuts && purchaseAssessment.suggestedCuts.length > 0) {
      parts.push("💡 SPECIFIC CUT-DOWN SUGGESTIONS:");
      parts.push("");
      
      purchaseAssessment.suggestedCuts.forEach((cut, index) => {
        parts.push(`${index + 1}. ${cut.category} (Priority: ${cut.priority.toUpperCase()})`);
        parts.push(`   Current Spend: ${formatCurrency(cut.currentSpend)}`);
        parts.push(`   Suggested Reduction: ${cut.suggestedReduction}%`);
        parts.push(`   💰 You'll Save: ${formatCurrency(cut.savedAmount)}/month`);
        parts.push(`   ✅ Action: ${cut.specificAction}`);
        parts.push(`   Why: ${cut.reason}`);
        parts.push("");
      });
      
      const totalSavings = purchaseAssessment.suggestedCuts.reduce((sum, cut) => sum + cut.savedAmount, 0);
      parts.push(`🎯 TOTAL POTENTIAL SAVINGS: ${formatCurrency(totalSavings)}/month`);
      parts.push("");
      
      parts.push("IMPORTANT: Use these SPECIFIC suggestions in your response!");
      parts.push("Example: 'Looking at your Domino's spending of ₹666, switching to home-made meals saves ₹400/month.'");
      parts.push("Example: 'Your cab expenses are ₹500/week. Taking the bus instead cuts this by 50%, saving ₹1,000/month.'");
      parts.push("");
    }
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

/**
 * Check if query needs factual answer lookup
 */
function shouldLookupFactualAnswer(query: string): boolean {
  const lowerQuery = query.toLowerCase();
  
  // Patterns that indicate need for factual definition
  const definitionPatterns = [
    "what is", "what's", "what are",
    "define", "definition of",
    "explain", "tell me about",
    "how does", "what does",
    "meaning of", "mean by",
  ];
  
  // Financial terms that benefit from factual lookup
  const financialTerms = [
    "compound interest", "simple interest",
    "mutual fund", "index fund", "equity", "debt",
    "sip", "systematic investment",
    "diversification", "asset allocation",
    "emergency fund",
    "inflation", "deflation",
    "apr", "interest rate",
    "credit score", "credit card",
    "budget", "budgeting",
    "savings rate",
    "net worth", "liability", "asset",
    "roi", "return on investment",
  ];
  
  // Check if query matches definition patterns
  const hasDefinitionPattern = definitionPatterns.some(pattern => lowerQuery.includes(pattern));
  
  // Check if query contains financial terms
  const hasFinancialTerm = financialTerms.some(term => lowerQuery.includes(term));
  
  return hasDefinitionPattern || hasFinancialTerm;
}

/**
 * Extract the financial concept to look up
 */
function extractFinancialConcept(query: string): string | null {
  const lowerQuery = query.toLowerCase();
  
  // Remove common question words
  let cleaned = lowerQuery
    .replace(/^(what is|what's|what are|define|definition of|explain|tell me about|how does|what does|meaning of|mean by)\s+/i, "")
    .replace(/\?$/,"")
    .trim();
  
  // Financial concept mapping for better search
  const conceptMap: Record<string, string> = {
    "sip": "SIP investment",
    "mutual funds": "mutual fund",
    "emergency funds": "emergency fund",
    "compounding": "compound interest",
    "diversifying": "diversification",
    "budgeting": "budget planning",
  };
  
  // Check if cleaned query matches known concepts
  for (const [key, value] of Object.entries(conceptMap)) {
    if (cleaned.includes(key)) {
      return value;
    }
  }
  
  // Return cleaned query if it looks like a financial term (2-4 words)
  const wordCount = cleaned.split(/\s+/).length;
  if (wordCount >= 1 && wordCount <= 4) {
    return cleaned;
  }
  
  return null;
}

/**
 * Detect if query is asking for purchase decision
 */
export function isPurchaseDecisionQuery(query: string): boolean {
  const lowerQuery = query.toLowerCase();
  
  const purchaseKeywords = [
    "should i buy", "should i purchase", "should i get",
    "can i afford", "can i buy", "good decision to buy",
    "is it ok to buy", "worth buying", "buy this",
    "purchase this", "get this", "afford this",
  ];
  
  return purchaseKeywords.some(kw => lowerQuery.includes(kw));
}

/**
 * Detect if query is asking for transaction evaluation
 */
export function isTransactionDecisionQuery(query: string): boolean {
  const lowerQuery = query.toLowerCase();
  
  const transactionKeywords = [
    "is this transaction ok", "this transaction ok", "transaction ok",
    "is this ok", "is ₹", "is rs", "is inr",
    "good decision", "should i spend", "ok to spend",
    "this spend ok", "is spending", "safe to spend",
  ];
  
  return transactionKeywords.some(kw => lowerQuery.includes(kw));
}

/**
 * Extract purchase amount and item from query
 */
export function extractPurchaseDetails(query: string): { amount: number | null; item: string | null } {
  const lowerQuery = query.toLowerCase();
  
  // Extract amount (₹15,000 or rs 15000 or 15k)
  const amountPatterns = [
    /₹\s*(\d+(?:,\d+)*(?:k)?)/i,
    /rs\.?\s*(\d+(?:,\d+)*(?:k)?)/i,
    /inr\s*(\d+(?:,\d+)*(?:k)?)/i,
    /(\d+(?:,\d+)*)\s*(?:rupees?|₹|rs)/i,
  ];
  
  let amount: number | null = null;
  for (const pattern of amountPatterns) {
    const match = lowerQuery.match(pattern);
    if (match && match[1]) {
      let amountStr = match[1].replace(/,/g, "");
      if (amountStr.endsWith("k")) {
        amount = parseInt(amountStr) * 1000;
      } else {
        amount = parseInt(amountStr);
      }
      break;
    }
  }
  
  // Extract item (phone, laptop, etc.)
  const itemPatterns = [
    /buy\s+(?:a\s+|an\s+)?(\w+(?:\s+\w+)?)/i,
    /purchase\s+(?:a\s+|an\s+)?(\w+(?:\s+\w+)?)/i,
    /get\s+(?:a\s+|an\s+)?(\w+(?:\s+\w+)?)/i,
    /for\s+(?:a\s+|an\s+)?(\w+(?:\s+\w+)?)/i,
  ];
  
  let item: string | null = null;
  for (const pattern of itemPatterns) {
    const match = query.match(pattern);
    if (match && match[1]) {
      item = match[1];
      break;
    }
  }
  
  return { amount, item };
}

/**
 * Analyze purchase affordability
 */
export async function analyzePurchaseAffordability(
  amount: number,
  item: string | null,
  context: ChaturUserContext,
): Promise<{
  decision: "Yes" | "No" | "Wait";
  reason: string;
  savingsPlan: string | null;
  alternativeSuggestion: string | null;
}> {
  const monthlyIncome = context.financial.totalEarned / (context.metadata.totalSnapshots || 1);
  const monthlySpend = context.financial.totalSpent / (context.metadata.totalSnapshots || 1);
  const currentBalance = context.financial.currentBalance;
  
  // Affordability thresholds
  const percentOfIncome = (amount / monthlyIncome) * 100;
  const percentOfBalance = (amount / currentBalance) * 100;
  const wouldDipEmergencyFund = amount > (currentBalance - 2000); // Keep ₹2k buffer
  
  // Decision logic
  if (percentOfIncome <= 10 && !wouldDipEmergencyFund) {
    return {
      decision: "Yes",
      reason: `Affordable—${percentOfIncome.toFixed(1)}% of monthly income (₹${monthlyIncome.toFixed(0)}) and won't impact emergency buffer.`,
      savingsPlan: null,
      alternativeSuggestion: item ? `Consider waiting for sales to save ₹${(amount * 0.15).toFixed(0)}-${(amount * 0.25).toFixed(0)}.` : null,
    };
  }
  
  if (percentOfIncome > 50 || wouldDipEmergencyFund) {
    const monthsToSave = Math.ceil(amount / (monthlyIncome - monthlySpend));
    return {
      decision: "No",
      reason: `Not affordable now—${percentOfIncome.toFixed(0)}% of monthly income. Would deplete emergency buffer.`,
      savingsPlan: `Save ₹${((amount / monthsToSave)).toFixed(0)}/month for ${monthsToSave} months without impacting daily needs.`,
      alternativeSuggestion: item ? `Look for budget ${item} options at ₹${(amount * 0.5).toFixed(0)}-${(amount * 0.7).toFixed(0)} range.` : null,
    };
  }
  
  // Wait - feasible but needs planning
  const monthsToSave = Math.ceil(amount / ((monthlyIncome - monthlySpend) * 0.5)); // Save 50% of surplus
  const monthlySavings = amount / monthsToSave;
  
  return {
    decision: "Wait",
    reason: `Feasible with planning—${percentOfIncome.toFixed(0)}% of income. Save up to avoid financial stress.`,
    savingsPlan: `Save ₹${monthlySavings.toFixed(0)}/month for ${monthsToSave} months. Cut ${context.spendingPatterns.topCategories[0]?.category || "top category"} by 15-20%.`,
    alternativeSuggestion: `Start saving now, reassess in 1 month when you have ₹${(monthlySavings).toFixed(0)} buffer.`,
  };
}

/**
 * Analyze transaction risk
 */
export async function analyzeTransactionRisk(
  amount: number,
  context: ChaturUserContext,
): Promise<{
  decision: "OK" | "Wait" | "Risky";
  reason: string;
  actions: string[];
}> {
  const avgTransaction = context.financial.totalSpent / context.financial.totalTransactions;
  const ratio = amount / avgTransaction;
  
  // Check against recent activity
  const weeklyAvg = context.recentActivity.last7Days.spent / 7;
  const isHighForWeek = amount > (weeklyAvg * 2);
  
  // Risk flags
  const isUnusuallyHigh = ratio > 3;
  const hasRiskFlags = Object.values(context.behavior.riskFlags).some(flag => flag);
  
  if (!isUnusuallyHigh && !isHighForWeek) {
    return {
      decision: "OK",
      reason: `Normal spending pattern—₹${amount} is ${ratio.toFixed(1)}x your avg transaction (₹${avgTransaction.toFixed(0)}).`,
      actions: ["Log the transaction", "Continue as usual"],
    };
  }
  
  if (isUnusuallyHigh && hasRiskFlags) {
    return {
      decision: "Risky",
      reason: `High risk—₹${amount} is ${ratio.toFixed(0)}x your avg spend. You have active risk flags (${Object.keys(context.behavior.riskFlags).filter(k => context.behavior.riskFlags[k as keyof typeof context.behavior.riskFlags]).join(", ")}).`,
      actions: [
        "⚠️ Verify transaction legitimacy",
        "📞 Call bank helpline: 18005700",
        "🔒 Check for fraud/unauthorized access",
        "❌ Don't proceed if unsure",
      ],
    };
  }
  
  return {
    decision: "Wait",
    reason: `Unusual amount—₹${amount} is ${ratio.toFixed(1)}x your typical spend (₹${avgTransaction.toFixed(0)}). Verify before proceeding.`,
    actions: [
      "Confirm this is an intentional purchase",
      "Check if it aligns with your budget",
      "Verify merchant/recipient",
      "Log after confirming",
    ],
  };
}

/**
 * Check if query needs financial calculations
 */
export function needsFinancialCalculation(query: string): boolean {
  const lowerQuery = query.toLowerCase();
  
  const calculationPatterns = [
    "how much", "calculate", "compute",
    "daily", "weekly", "monthly",
    "save", "saving", "savings goal",
    "spend", "spending budget",
    "afford", "affordability",
    "reach", "achieve", "goal",
    "per day", "per week", "per month",
    "budget for", "allocate",
  ];
  
  return calculationPatterns.some(pattern => lowerQuery.includes(pattern));
}

/**
 * Extract calculation parameters from query
 */
export function extractCalculationParams(
  query: string,
  context: ChaturUserContext,
): {
  type: "savings_goal" | "daily_budget" | "affordability" | "budget_allocation" | null;
  params: Record<string, any>;
} {
  const lowerQuery = query.toLowerCase();
  
  // Savings goal: "save 200 per month", "reach 10000 in 5 months"
  if (lowerQuery.includes("save") || lowerQuery.includes("savings goal") || lowerQuery.includes("reach")) {
    // Extract target amount
    const targetMatch = query.match(/(?:save|reach|goal of|target of|accumulate)\s*(?:about|around|approximately)?\s*₹?\s*(\d+(?:,\d+)*(?:k|K)?)/i);
    const timeframeMatch = query.match(/(?:in|within|over)\s*(\d+)\s*(month|months|week|weeks|year|years)/i);
    
    let targetAmount = 0;
    if (targetMatch && targetMatch[1]) {
      const amountStr = targetMatch[1].replace(/,/g, "");
      targetAmount = amountStr.toLowerCase().includes("k") 
        ? parseFloat(amountStr) * 1000 
        : parseFloat(amountStr);
    }
    
    let timeframeMonths = 6; // Default 6 months
    if (timeframeMatch && timeframeMatch[1] && timeframeMatch[2]) {
      const value = parseInt(timeframeMatch[1]);
      const unit = timeframeMatch[2].toLowerCase();
      if (unit.startsWith("week")) {
        timeframeMonths = Math.ceil(value / 4);
      } else if (unit.startsWith("year")) {
        timeframeMonths = value * 12;
      } else {
        timeframeMonths = value;
      }
    }
    
    return {
      type: "savings_goal",
      params: {
        targetAmount,
        currentSavings: context.financial.currentBalance,
        timeframeMonths,
        monthlyIncome: context.financial.totalEarned,
      },
    };
  }
  
  // Daily budget: "how much should i spend daily", "daily budget"
  if (lowerQuery.includes("daily") && (lowerQuery.includes("spend") || lowerQuery.includes("budget"))) {
    // Extract savings goal from query if mentioned
    const savingsMatch = query.match(/save\s*₹?\s*(\d+(?:,\d+)*)/i);
    let savingsGoal = context.financial.totalEarned * 0.2; // Default 20%
    
    if (savingsMatch && savingsMatch[1]) {
      savingsGoal = parseFloat(savingsMatch[1].replace(/,/g, ""));
    }
    
    // Estimate fixed expenses (50% of income or actual from data)
    const fixedExpenses = context.financial.totalSpent * 0.5;
    
    return {
      type: "daily_budget",
      params: {
        monthlyIncome: context.financial.totalEarned,
        fixedExpenses,
        savingsGoal,
      },
    };
  }
  
  // Budget allocation: "how should i allocate", "budget breakdown"
  if (lowerQuery.includes("allocate") || lowerQuery.includes("budget breakdown") || lowerQuery.includes("50/30/20")) {
    return {
      type: "budget_allocation",
      params: {
        monthlyIncome: context.financial.totalEarned,
      },
    };
  }
  
  return { type: null, params: {} };
}

/**
 * Perform calculation and format result
 */
export function performCalculation(
  type: "savings_goal" | "daily_budget" | "affordability" | "budget_allocation",
  params: Record<string, any>,
): string {
  try {
    switch (type) {
      case "savings_goal": {
        const result = calculateSavingsGoal(
          params.targetAmount,
          params.currentSavings,
          params.timeframeMonths,
          params.monthlyIncome,
        );
        
        let output = `📊 Savings Goal Calculation:\n\n`;
        output += `Target: ${formatCurrency(result.targetAmount)}\n`;
        output += `Current Savings: ${formatCurrency(result.currentSavings)}\n`;
        output += `Need to Save: ${formatCurrency(result.totalNeeded)}\n`;
        output += `Timeframe: ${result.timeframeMonths} months\n\n`;
        output += `💰 Required Savings:\n`;
        output += `• Daily: ${formatCurrency(result.dailyRequired)}\n`;
        output += `• Weekly: ${formatCurrency(result.weeklyRequired)}\n`;
        output += `• Monthly: ${formatCurrency(result.monthlyRequired)}\n\n`;
        
        if (result.isAchievable) {
          output += `✅ Achievable! This is ${formatPercentage((result.monthlyRequired / params.monthlyIncome) * 100)} of your monthly income.\n`;
        } else {
          output += `⚠️ Challenging - this requires ${formatPercentage((result.monthlyRequired / params.monthlyIncome) * 100)} of your monthly income.\n\n`;
          if (result.recommendedAdjustment) {
            output += `💡 Suggestion: ${result.recommendedAdjustment.suggestion}\n`;
          }
        }
        
        return output;
      }
      
      case "daily_budget": {
        const result = calculateDailyBudget(
          params.monthlyIncome,
          params.fixedExpenses,
          params.savingsGoal,
        );
        
        let output = `📊 Daily Budget Calculation:\n\n`;
        output += `Monthly Income: ${formatCurrency(result.breakdown.income)}\n`;
        output += `Fixed Expenses: ${formatCurrency(result.breakdown.fixed)}\n`;
        output += `Savings Goal: ${formatCurrency(result.breakdown.savings)}\n`;
        output += `Discretionary: ${formatCurrency(result.breakdown.discretionary)}\n\n`;
        output += `💳 Your Spending Budget:\n`;
        output += `• Daily: ${formatCurrency(result.dailyBudget)}\n`;
        output += `• Weekly: ${formatCurrency(result.weeklyBudget)}\n\n`;
        
        if (result.dailyBudget < 100) {
          output += `⚠️ Tight budget! Focus on essentials and track every rupee.\n`;
        } else if (result.dailyBudget > 500) {
          output += `✅ Comfortable buffer! Remember to stay mindful of wants vs needs.\n`;
        } else {
          output += `✅ Balanced budget! Track daily to stay on target.\n`;
        }
        
        return output;
      }
      
      case "budget_allocation": {
        const result = calculateBudgetAllocation(params.monthlyIncome);
        
        let output = `📊 Budget Allocation (50/30/20 Rule):\n\n`;
        output += `Monthly Income: ${formatCurrency(result.income)}\n\n`;
        output += `💰 Recommended Allocation:\n`;
        output += `• Needs (50%): ${formatCurrency(result.needs)}\n`;
        output += `  (Rent, food, utilities, transport)\n\n`;
        output += `• Wants (30%): ${formatCurrency(result.wants)}\n`;
        output += `  (Entertainment, dining out, hobbies)\n\n`;
        output += `• Savings (20%): ${formatCurrency(result.savings)}\n`;
        output += `  (Emergency fund, investments, goals)\n\n`;
        output += `🛡️ Emergency Fund Target:\n`;
        output += `• Minimum (3 months): ${formatCurrency(result.emergencyFundMin)}\n`;
        output += `• Ideal (6 months): ${formatCurrency(result.emergencyFundMax)}\n`;
        
        return output;
      }
      
      default:
        return "";
    }
  } catch (error) {
    console.error("[chatur-calc] Calculation error:", error);
    return "I encountered an issue with the calculation. Let me help you manually instead.";
  }
}
