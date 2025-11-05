/**
 * Chatur Agent Coordinator
 * 
 * Integrates Chatur with the new query routing system and other agents.
 * Ensures Chatur gets full context from Param's vector database and
 * coordinates with Mill for data retrieval when needed.
 * 
 * Enhanced with factual answer lookup for educational coaching.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { getAgentConfig } from "../../config.js";
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
import {
  buildLoanScenarios,
  calculateLoanAmount,
  estimateStampDutyBuffer,
  formatRupees as formatLoanRupees,
  pickAffordableScenario,
  type LoanScenario,
} from "../../utils/loan-calculator.js";

interface GoalTimeframe {
  label: string;
  months?: number;
  targetDate?: string;
}

export interface FinancialGoal {
  id: string;
  summary: string;
  rawStatement: string;
  type: "purchase" | "savings" | "debt_repayment" | "income_growth" | "habit";
  priority: "low" | "medium" | "high";
  targetAmount?: number;
  targetItem?: string;
  timeframe?: GoalTimeframe;
  createdAt: string;
  updatedAt: string;
  status: "active" | "completed";
  purchaseDetails?: PurchaseGoalDetails;
}

interface PurchaseGoalDetails {
  propertyPrice?: number;
  downPaymentPercent?: number;
  availableSavings?: number;
  loanRatePercent?: number;
  latestLoanAmount?: number;
  latestStampDutyEstimate?: number;
  loanScenarios?: LoanScenario[];
  affordabilityStatus?: "within_limit" | "stretch" | "requires_review";
  affordabilityNote?: string;
  missingInputs?: string[];
  ctaSuggestion?: string;
  loanIntelSources?: LoanIntelSource[];
  lastIntelFetchedAt?: string;
}

interface LoanIntelSource {
  topic: "interest_rate" | "ltv_rule" | "stamp_duty" | "eligibility" | "generic";
  query: string;
  summary: string;
  retrievedAt: string;
}

export interface AgentActionRecommendation {
  agent: "mill" | "param" | "coach" | "dev";
  action: string;
  reason: string;
  cadence?: string;
  relatedGoalId?: string;
}

interface GoalProcessingResult {
  goal: FinancialGoal;
  isNew: boolean;
  calculationSummary?: string;
  loanSummary?: string;
  coachNotes: string[];
  agentRecommendations: AgentActionRecommendation[];
  ctaSuggestion?: string;
  missingInputs?: string[];
}

interface GoalPlanDetails {
  calculationSummary?: string;
  loanSummary?: string;
  coachNotes: string[];
  agentRecommendations: AgentActionRecommendation[];
  immediateActions: string[];
  shortTermActions: string[];
  ctaSuggestion?: string;
  missingInputs?: string[];
}

const sessionStore = new Map<string, ChaturCoachingSession>();

const LOAN_INTEL_REFRESH_HOURS = 24;

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
  goals: FinancialGoal[];
  currentGoals?: string[];
  actionPlan?: {
    immediate: string[];
    shortTerm: string[];
    progress: Record<string, boolean>;
  };
  agentRecommendations: AgentActionRecommendation[];
  goalCoachingNotes?: string[];
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
  agentRecommendations?: AgentActionRecommendation[];
}> {
  console.log("[chatur] Handling coaching query:", userQuery);
  
  // Load or create session
  const session = await loadOrCreateSession(userId, options.sessionId);
  const calculationSnippets: string[] = [];

  const goalProcessing = detectGoalIntent(userQuery, session);
  if (goalProcessing) {
    if (goalProcessing.calculationSummary) {
      calculationSnippets.push(goalProcessing.calculationSummary);
    }

    if (goalProcessing.loanSummary) {
      calculationSnippets.push(goalProcessing.loanSummary);
    }

    if (goalProcessing.coachNotes.length > 0) {
      const noteSet = new Set(session.goalCoachingNotes ?? []);
  goalProcessing.coachNotes.forEach((note: string) => noteSet.add(note));
      session.goalCoachingNotes = Array.from(noteSet);
    }

    if (goalProcessing.agentRecommendations.length > 0) {
      session.agentRecommendations = mergeAgentRecommendations(
        session.agentRecommendations,
        goalProcessing.agentRecommendations,
      );
    }
  }

  const propertyGoal = session.goals.find((goal) => goal.type === "purchase" && looksLikePropertyGoal(goal));
  if (propertyGoal) {
    const loanIntelSnippet = await gatherLoanIntelForQuery(propertyGoal, userQuery);
    if (loanIntelSnippet) {
      calculationSnippets.push(loanIntelSnippet);
    }
  }
  
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
  if (calculationResult) {
    calculationSnippets.push(calculationResult);
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
    const queryOptions: Record<string, unknown> = {};
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
  const combinedCalculationResult =
    calculationSnippets.length > 0 ? calculationSnippets.join("\n\n") : undefined;

  const response = await generateCoachingResponse(
    userQuery,
    session,
    transactionData,
    factualAnswers,
    combinedCalculationResult,
    expenseAnalysis,
    purchaseAssessment,
  );
  
  // Update session
  session.conversationHistory.push(
    { role: "user", content: userQuery, timestamp: new Date().toISOString() },
    { role: "assistant", content: response, timestamp: new Date().toISOString() },
  );
  session.currentGoals = session.goals.map((goal) => goal.summary);
  sessionStore.set(userId, session);
  
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
    agentRecommendations?: AgentActionRecommendation[];
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
  
  if (session.agentRecommendations.length > 0) {
    result.agentRecommendations = [...session.agentRecommendations];
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
  const existing = sessionStore.get(userId);
  if (existing && (!sessionId || existing.sessionId === sessionId)) {
    return existing;
  }

  console.log("[chatur] Loading user context from vector database...");
  const userContext = await buildChaturUserContext(userId);

  const inheritedGoals = existing?.goals ? [...existing.goals] : [];
  const inheritedRecommendations = existing?.agentRecommendations ? [...existing.agentRecommendations] : [];
  const inheritedNotes = existing?.goalCoachingNotes ? [...existing.goalCoachingNotes] : undefined;
  const inheritedActionPlan = existing?.actionPlan
    ? {
        immediate: [...existing.actionPlan.immediate],
        shortTerm: [...existing.actionPlan.shortTerm],
        progress: { ...existing.actionPlan.progress },
      }
    : { immediate: [], shortTerm: [], progress: {} };

  const session: ChaturCoachingSession = {
    sessionId: sessionId || generateSessionId(),
    userId,
    startedAt: new Date().toISOString(),
    userContext,
    conversationHistory: [],
    goals: inheritedGoals,
    currentGoals: inheritedGoals.map((goal) => goal.summary),
    actionPlan: inheritedActionPlan,
    agentRecommendations: inheritedRecommendations,
    goalCoachingNotes: inheritedNotes ?? [],
  };

  sessionStore.set(userId, session);
  return session;
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
  const { apiKey, model } = getAgentConfig("agent4"); // Chatur uses agent4 (Coach)
  const provider = createGoogleGenerativeAI({ apiKey });
  const languageModel = provider(model);
  
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

    return ensureCoachDisclaimer(result.text ?? "");
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
  const ctaSuggestions: string[] = [];
  
  parts.push(`User Query: "${userQuery}"`);
  parts.push("");

  const personalizationAnchors = collectPersonalizationAnchors(session, transactionData, expenseAnalysis);
  if (personalizationAnchors.length > 0) {
    parts.push("=== PERSONALIZATION ANCHORS ===");
  personalizationAnchors.forEach((anchor: string) => parts.push(`- ${anchor}`));
    parts.push("Call these out explicitly when coaching so the user knows why the tip fits their goals.");
    parts.push("");
  }
  
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

  if (session.goals.length > 0) {
    parts.push("=== DECLARED LONG-TERM GOALS ===");
    session.goals.forEach((goal, index) => {
      parts.push(`${index + 1}. ${goal.summary}${goal.timeframe?.label ? ` (${goal.timeframe.label})` : ""}`);
      if (goal.targetAmount !== undefined) {
        parts.push(`   Target Amount: ${formatCurrency(goal.targetAmount)}`);
      }
      if (goal.targetItem) {
        parts.push(`   Focus Item: ${capitalize(goal.targetItem)}`);
      }
      if (goal.priority) {
        parts.push(`   Priority: ${goal.priority.toUpperCase()}`);
      }
      parts.push(`   Status: ${goal.status}`);
      parts.push(`   Last Updated: ${goal.updatedAt}`);

      const purchaseDetails = goal.purchaseDetails;
      if (purchaseDetails) {
        if (purchaseDetails.propertyPrice !== undefined) {
          parts.push(`   Property Price: ${formatLoanRupees(purchaseDetails.propertyPrice)}`);
        }
        if (purchaseDetails.downPaymentPercent !== undefined) {
          const downPaymentValue = purchaseDetails.propertyPrice !== undefined
            ? formatLoanRupees(Math.round(purchaseDetails.propertyPrice * (purchaseDetails.downPaymentPercent / 100)))
            : null;
          const downPercentDisplay = purchaseDetails.downPaymentPercent.toFixed(1).replace(/\.0$/, "");
          parts.push(
            `   Down Payment: ${downPercentDisplay}%${downPaymentValue ? ` (${downPaymentValue})` : ""}`,
          );
        }
        if (purchaseDetails.availableSavings !== undefined) {
          parts.push(`   Savings Applied: ${formatLoanRupees(purchaseDetails.availableSavings)}`);
        }
        if (purchaseDetails.latestLoanAmount !== undefined) {
          parts.push(`   Loan Needed: ${formatLoanRupees(Math.max(0, purchaseDetails.latestLoanAmount))}`);
        }
        if (purchaseDetails.latestStampDutyEstimate !== undefined) {
          parts.push(`   Stamp Duty Buffer: ${formatLoanRupees(purchaseDetails.latestStampDutyEstimate)}`);
        }
        if (purchaseDetails.affordabilityNote) {
          parts.push(`   Affordability: ${purchaseDetails.affordabilityNote}`);
        }
        if (purchaseDetails.loanScenarios && purchaseDetails.loanScenarios.length > 0) {
          parts.push("   EMI Options (top 2):");
          purchaseDetails.loanScenarios.slice(0, 2).forEach((scenario) => {
            const ratioPercent = scenario.affordabilityRatio > 0
              ? formatPercentage(scenario.affordabilityRatio * 100, 0)
              : "n/a";
            parts.push(`     - ${scenario.tenureYears} yrs → EMI ${formatLoanRupees(scenario.emi)} (${ratioPercent} of income)`);
          });
        }
        if (purchaseDetails.loanIntelSources && purchaseDetails.loanIntelSources.length > 0) {
          parts.push("   Market Intel:");
          purchaseDetails.loanIntelSources.slice(0, 2).forEach((source) => {
            parts.push(`     • ${source.topic.replace(/_/g, " ")}: ${source.summary.split("\n")[0]}`);
            const remaining = source.summary.split("\n").slice(1).join("\n");
            if (remaining) {
              parts.push(`       ${remaining}`);
            }
          });
        }
        if (purchaseDetails.missingInputs && purchaseDetails.missingInputs.length > 0) {
          parts.push(`   Missing Loan Inputs: ${purchaseDetails.missingInputs.join(", ")}`);
        }
        if (purchaseDetails.ctaSuggestion) {
          ctaSuggestions.push(purchaseDetails.ctaSuggestion);
        }
      }
    });
    parts.push("Remember to anchor your guidance to these goals and show how today's actions move them forward.");
    parts.push("");
  }

  const goalNotes = session.goalCoachingNotes ?? [];
  if (goalNotes.length > 0) {
    parts.push("Goal Coaching Notes:");
    goalNotes.forEach((note) => parts.push(`- ${note}`));
    parts.push("");
  }

  const distinctCtas = Array.from(new Set(ctaSuggestions));
  if (distinctCtas.length > 0) {
    parts.push("CTA Suggestions:");
    distinctCtas.forEach((cta) => parts.push(`- ${cta}`));
    parts.push("");
  }

  if (session.actionPlan && (session.actionPlan.immediate.length > 0 || session.actionPlan.shortTerm.length > 0)) {
    parts.push("=== ACTIVE ACTION PLAN ===");
    if (session.actionPlan.immediate.length > 0) {
      parts.push("Immediate (next 7 days):");
      session.actionPlan.immediate.forEach((item) => parts.push(`• ${item}`));
    }
    if (session.actionPlan.shortTerm.length > 0) {
      parts.push("");
      parts.push("Short-Term (this month):");
      session.actionPlan.shortTerm.forEach((item) => parts.push(`• ${item}`));
    }
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

function detectGoalIntent(query: string, session: ChaturCoachingSession): GoalProcessingResult | null {
  const normalized = query.trim();
  if (normalized.length === 0) {
    return null;
  }

  const lower = normalized.toLowerCase();
  const goalIntentPatterns: RegExp[] = [
    /i\s+(?:want|plan|need|would like)\s+to\s+/,
    /my\s+goal/,
    /goal\s+is/,
    /saving\s+for/,
    /save\s+for/,
    /plan\s+for/,
    /buy\s+/,
    /purchase\s+/,
    /down\s+payment/,
    /next\s+year/,
  ];

  if (!goalIntentPatterns.some((pattern) => pattern.test(lower))) {
    return null;
  }

  let goalType: FinancialGoal["type"] = "savings";
  if (/(buy|purchase|down payment|house|home|car|bike|laptop|phone|property)/i.test(lower)) {
    goalType = "purchase";
  } else if (/(pay off|repay|clear|loan|debt)/i.test(lower)) {
    goalType = "debt_repayment";
  } else if (/(earn more|increase income|side hustle|more gigs|extra income)/i.test(lower)) {
    goalType = "income_growth";
  } else if (/(habit|routine|consistency)/i.test(lower)) {
    goalType = "habit";
  }

  const purchaseDetails = goalType === "purchase" ? extractPurchaseDetails(query) : { amount: null, item: null };
  const parsedAmount = parseCurrencyAmount(query) ?? (purchaseDetails.amount ?? undefined);
  const timeframe = parseGoalTimeframe(query);
  const summary = buildGoalSummary(goalType, purchaseDetails.item ?? undefined, parsedAmount, timeframe, normalized);
  const nowIso = new Date().toISOString();

  if (!session.goals) {
    session.goals = [];
  }

  let goal = session.goals.find((candidate) => candidate.summary.toLowerCase() === summary.toLowerCase());
  let isNew = false;

  if (!goal) {
    isNew = true;
    const newGoal: FinancialGoal = {
      id: generateGoalId(),
      summary,
      rawStatement: normalized,
      type: goalType,
      priority: deriveGoalPriority(timeframe),
      createdAt: nowIso,
      updatedAt: nowIso,
      status: "active",
    };

    if (parsedAmount !== undefined) {
      newGoal.targetAmount = parsedAmount;
    }

    if (purchaseDetails.item) {
      newGoal.targetItem = purchaseDetails.item;
    }

    if (timeframe) {
      newGoal.timeframe = timeframe;
    }

    session.goals.push(newGoal);
    goal = newGoal;
    console.log(`[chatur] 📌 Recorded new long-term goal: ${newGoal.summary}`);
  } else {
    let updated = false;

    if (parsedAmount !== undefined && goal.targetAmount !== parsedAmount) {
      goal.targetAmount = parsedAmount;
      updated = true;
    }

    if (purchaseDetails.item && goal.targetItem !== purchaseDetails.item) {
      goal.targetItem = purchaseDetails.item;
      updated = true;
    }

    if (timeframe && (!goal.timeframe || goal.timeframe.label !== timeframe.label)) {
      goal.timeframe = timeframe;
      updated = true;
    }

    if (updated) {
      goal.priority = deriveGoalPriority(goal.timeframe);
      console.log(`[chatur] 🔄 Updated goal '${goal.summary}' with new details.`);
    }

    goal.rawStatement = normalized;
    goal.updatedAt = nowIso;
  }

  if (goal.type === "purchase") {
    const extractedDetails = extractLoanInputsFromQuery(query);
    const purchaseDetails = goal.purchaseDetails ?? {};

    if (extractedDetails.propertyPrice !== undefined) {
      purchaseDetails.propertyPrice = extractedDetails.propertyPrice;
    } else if (purchaseDetails.propertyPrice === undefined && parsedAmount !== undefined) {
      purchaseDetails.propertyPrice = parsedAmount;
    }

    if (extractedDetails.downPaymentPercent !== undefined) {
      purchaseDetails.downPaymentPercent = extractedDetails.downPaymentPercent;
    }

    if (extractedDetails.availableSavings !== undefined) {
      purchaseDetails.availableSavings = extractedDetails.availableSavings;
    }

    if (extractedDetails.loanRatePercent !== undefined) {
      purchaseDetails.loanRatePercent = extractedDetails.loanRatePercent;
    }

    goal.purchaseDetails = purchaseDetails;
  }

  const planDetails = buildGoalPlan(goal, session.userContext);
  applyGoalPlanToSession(session, goal, planDetails);

  const result: GoalProcessingResult = {
    goal,
    isNew,
    coachNotes: planDetails.coachNotes,
    agentRecommendations: planDetails.agentRecommendations,
  };

  if (planDetails.calculationSummary) {
    result.calculationSummary = planDetails.calculationSummary;
  }

  if (planDetails.loanSummary) {
    result.loanSummary = planDetails.loanSummary;
  }

  if (planDetails.ctaSuggestion) {
    result.ctaSuggestion = planDetails.ctaSuggestion;
  }

  if (planDetails.missingInputs) {
    result.missingInputs = [...planDetails.missingInputs];
  }

  return result;
}

function applyGoalPlanToSession(
  session: ChaturCoachingSession,
  goal: FinancialGoal,
  plan: GoalPlanDetails,
): void {
  const actionPlan = ensureActionPlan(session);

  plan.immediateActions.forEach((action) => {
    if (!actionPlan.immediate.includes(action)) {
      actionPlan.immediate.push(action);
    }
  });

  plan.shortTermActions.forEach((action) => {
    if (!actionPlan.shortTerm.includes(action)) {
      actionPlan.shortTerm.push(action);
    }
  });

  if (!(goal.id in actionPlan.progress)) {
    actionPlan.progress[goal.id] = false;
  }
}

function ensureActionPlan(session: ChaturCoachingSession): NonNullable<ChaturCoachingSession["actionPlan"]> {
  if (!session.actionPlan) {
    session.actionPlan = { immediate: [], shortTerm: [], progress: {} };
  }
  return session.actionPlan;
}

function buildGoalPlan(goal: FinancialGoal, context: ChaturUserContext): GoalPlanDetails {
  const details: GoalPlanDetails = {
    coachNotes: [],
    agentRecommendations: [],
    immediateActions: [],
    shortTermActions: [],
  };

  if (goal.status !== "active") {
    details.coachNotes.push(`Goal '${goal.summary}' is marked as ${goal.status}. Confirm status before advising.`);
    return details;
  }

  const topCategory = context.spendingPatterns.topCategories[0]?.category ?? "top category";
  const monthlyIncomeEstimate = context.metadata.totalSnapshots > 0
    ? context.financial.totalEarned / context.metadata.totalSnapshots
    : context.financial.totalEarned;

  if ((goal.type === "purchase" || goal.type === "savings") && goal.targetAmount && goal.timeframe?.months) {
    const calculation = calculateSavingsGoal(
      goal.targetAmount,
      context.financial.currentBalance,
      goal.timeframe.months,
      context.financial.totalEarned,
    );

    const timeframeLabel = goal.timeframe.label ?? `${goal.timeframe.months} months`;
    const incomeShareValue = monthlyIncomeEstimate > 0
      ? (calculation.monthlyRequired / monthlyIncomeEstimate) * 100
      : undefined;
    const incomeShareText = incomeShareValue !== undefined
      ? formatPercentage(incomeShareValue)
      : "n/a";

    let summary = `🏁 Goal Plan: ${goal.summary}\n\n`;
    summary += `Target: ${formatCurrency(goal.targetAmount)}\n`;
    summary += `Current Savings: ${formatCurrency(context.financial.currentBalance)}\n`;
    summary += `Timeframe: ${timeframeLabel} (${goal.timeframe.months} months)\n\n`;
    summary += "Required Contributions:\n";
    summary += `• Daily: ${formatCurrency(calculation.dailyRequired)}\n`;
    summary += `• Weekly: ${formatCurrency(calculation.weeklyRequired)}\n`;
    summary += `• Monthly: ${formatCurrency(calculation.monthlyRequired)}\n\n`;
    summary += calculation.isAchievable
      ? `✅ Achievable at ${incomeShareText} of observed income.\n`
      : `⚠️ Requires ${incomeShareText} of observed income – adjust spending or extend timeline.\n`;
    if (calculation.recommendedAdjustment) {
      summary += `💡 ${calculation.recommendedAdjustment.suggestion}\n`;
    }

    details.calculationSummary = summary;
    details.immediateActions.push(
      `Automate transfers of ${formatCurrency(calculation.weeklyRequired)} each week toward '${goal.summary}'.`,
    );
    details.shortTermActions.push(
      `Reduce spend in ${topCategory} by 15% to free ${formatCurrency(calculation.weeklyRequired)} weekly for '${goal.summary}'.`,
    );
    details.agentRecommendations.push({
      agent: "mill",
      action: `Track savings contributions for '${goal.summary}'`,
      reason: "Monitor deposits and surface missed contributions for follow-up.",
      cadence: "weekly",
      relatedGoalId: goal.id,
    });
    details.agentRecommendations.push({
      agent: "param",
      action: `Factor '${goal.summary}' into habit insight refresh`,
      reason: "Highlight spending patterns that help or hurt progress.",
      relatedGoalId: goal.id,
    });
  } else if (goal.type === "purchase" || goal.type === "savings") {
    details.coachNotes.push(`Gather the estimated cost and deadline for '${goal.summary}' to create a savings schedule.`);
    details.immediateActions.push(`Clarify amount and timeline for '${goal.summary}'.`);
    if (!goal.timeframe) {
      details.coachNotes.push("Encourage the user to specify when they want to hit this goal (e.g., \"in 12 months\").");
    }
    details.agentRecommendations.push({
      agent: "coach",
      action: `Collect missing details for '${goal.summary}'`,
      reason: "Goal lacks amount or timeline; follow up next turn.",
      relatedGoalId: goal.id,
    });
  } else if (goal.type === "debt_repayment") {
    details.coachNotes.push("Map out balances, rates, and minimums to prioritize repayments (avalanche or snowball).");
    details.immediateActions.push("List all debts with outstanding balance and interest rate to choose payoff order.");
    details.agentRecommendations.push({
      agent: "mill",
      action: `Monitor debt repayments for '${goal.summary}'`,
      reason: "Track payments and alert if a cycle is missed.",
      cadence: "monthly",
      relatedGoalId: goal.id,
    });
  } else if (goal.type === "income_growth") {
    details.coachNotes.push("Explore higher-paying gigs, skill upgrades, or schedule optimization to raise income.");
    details.shortTermActions.push("Identify three skill upgrades or gig opportunities that boost income this quarter.");
  }

  if (goal.type === "purchase" && looksLikePropertyGoal(goal)) {
    enhancePropertyPurchasePlan(goal, context, details, monthlyIncomeEstimate, topCategory);
  }

  return details;
}

function enhancePropertyPurchasePlan(
  goal: FinancialGoal,
  context: ChaturUserContext,
  plan: GoalPlanDetails,
  monthlyIncomeEstimate: number,
  topCategory: string,
): void {
  const purchaseDetails = goal.purchaseDetails ?? (goal.purchaseDetails = {});
  const inferredPropertyPrice = purchaseDetails.propertyPrice ?? goal.targetAmount;
  if (inferredPropertyPrice !== undefined && purchaseDetails.propertyPrice === undefined) {
    purchaseDetails.propertyPrice = inferredPropertyPrice;
  }

  const propertyPrice = purchaseDetails.propertyPrice;
  const downPaymentPercent = purchaseDetails.downPaymentPercent;
  const availableSavings = purchaseDetails.availableSavings;
  const ratePercent = purchaseDetails.loanRatePercent ?? 8.5;

  const missing: string[] = [];
  if (propertyPrice === undefined) {
    missing.push("property price");
  }
  if (downPaymentPercent === undefined) {
    missing.push("down-payment %");
  }
  if (availableSavings === undefined) {
    missing.push("savings available");
  }

  purchaseDetails.missingInputs = missing;

  if (missing.length > 0) {
    const cta = buildLoanInputCTA(missing);
    if (cta && !plan.ctaSuggestion) {
      plan.ctaSuggestion = cta;
    }
    plan.missingInputs = [...missing];
    purchaseDetails.ctaSuggestion = cta;
    delete purchaseDetails.loanScenarios;
    delete purchaseDetails.latestLoanAmount;
    delete purchaseDetails.latestStampDutyEstimate;
    delete purchaseDetails.affordabilityStatus;
    delete purchaseDetails.affordabilityNote;
    plan.coachNotes.push(`Need ${missing.join(", ")} for '${goal.summary}' before running EMI math.`);
    return;
  }

  delete purchaseDetails.ctaSuggestion;
  delete plan.missingInputs;

  const propertyPriceValue = propertyPrice ?? 0;
  const downPaymentAmount = Math.round(propertyPriceValue * (downPaymentPercent! / 100));
  const loanAmount = calculateLoanAmount(propertyPriceValue, downPaymentPercent!, availableSavings!);
  const stampDuty = estimateStampDutyBuffer(propertyPriceValue);
  const scenarios = loanAmount > 0
    ? buildLoanScenarios(
        loanAmount,
        ratePercent,
        [15, 20, 25, 30],
        monthlyIncomeEstimate > 0 ? monthlyIncomeEstimate : undefined,
      )
    : [];

  purchaseDetails.propertyPrice = propertyPriceValue;
  purchaseDetails.downPaymentPercent = downPaymentPercent!;
  purchaseDetails.availableSavings = availableSavings!;
  purchaseDetails.loanRatePercent = ratePercent;
  purchaseDetails.latestLoanAmount = loanAmount;
  purchaseDetails.latestStampDutyEstimate = stampDuty;
  purchaseDetails.loanScenarios = scenarios;

  let affordabilityStatus: PurchaseGoalDetails["affordabilityStatus"] = "requires_review";
  let affordabilityNote = "";

  if (loanAmount <= 0) {
    affordabilityStatus = "within_limit";
    affordabilityNote = "Savings cover the property—no loan required.";
    purchaseDetails.loanScenarios = [];
  } else if (monthlyIncomeEstimate <= 0) {
    affordabilityStatus = "requires_review";
    affordabilityNote = "Need reliable monthly income data to check EMI affordability.";
  } else {
    const affordableScenario = pickAffordableScenario(scenarios, 0.35);
    if (affordableScenario) {
      affordabilityStatus = "within_limit";
      affordabilityNote = `${formatPercentage(affordableScenario.affordabilityRatio * 100, 0)} of monthly income at ${affordableScenario.tenureYears} years.`;
    } else {
      affordabilityStatus = "stretch";
      affordabilityNote = "All EMI options exceed 35% of income—work the 3 levers before committing.";
    }
  }

  purchaseDetails.affordabilityStatus = affordabilityStatus;
  purchaseDetails.affordabilityNote = affordabilityNote;
  purchaseDetails.missingInputs = [];

  const summaryLines: string[] = [];
  summaryLines.push(`🏦 Loan Snapshot (${formatLoanRupees(propertyPriceValue)} target @ ${ratePercent.toFixed(2)}% APR)`);
  summaryLines.push("");
  summaryLines.push(`Down payment (${downPaymentPercent!.toFixed(1).replace(/\.0$/, "")}%) → ${formatLoanRupees(downPaymentAmount)}`);
  summaryLines.push(`Savings applied → ${formatLoanRupees(availableSavings!)}`);
  summaryLines.push(`Loan needed → ${formatLoanRupees(Math.max(0, loanAmount))}`);
  summaryLines.push(`Stamp duty buffer (~9%) → ${formatLoanRupees(stampDuty)}`);
  summaryLines.push("");

  if (loanAmount <= 0) {
    summaryLines.push("✅ No loan required with current savings and down payment.");
  } else if (scenarios.length === 0) {
    summaryLines.push("⚠️ Unable to compute EMI scenarios—verify the inputs.");
  } else {
    summaryLines.push("EMI Options (≤35% income ideal):");
    scenarios.forEach((scenario) => {
      const ratioPercent = monthlyIncomeEstimate > 0 && scenario.affordabilityRatio > 0
        ? formatPercentage(scenario.affordabilityRatio * 100, 0)
        : "n/a";
      summaryLines.push(`• ${scenario.tenureYears} yrs → EMI ${formatLoanRupees(scenario.emi)} (${ratioPercent} of income), interest ${formatLoanRupees(scenario.totalInterest)}`);
    });

    if (monthlyIncomeEstimate > 0) {
      summaryLines.push("");
      summaryLines.push(
        affordabilityStatus === "within_limit"
          ? "✅ At least one tenure stays within the 35% EMI guardrail."
          : "⚠️ All tenures breach the 35% EMI guardrail—push savings, earnings, or extend timeline.",
      );
    }
  }

  plan.loanSummary = summaryLines.join("\n");

  if (!plan.ctaSuggestion) {
    plan.ctaSuggestion = `Confirm these numbers so we can lock the EMI plan: price ${formatLoanRupees(propertyPriceValue)}, ${downPaymentPercent!.toFixed(0)}% down, savings ${formatLoanRupees(availableSavings!)}.`;
  }

  if (plan.ctaSuggestion) {
    purchaseDetails.ctaSuggestion = plan.ctaSuggestion;
  }

  const stampDutyAction = `Ring-fence ${formatLoanRupees(stampDuty)} for stamp duty & registration.`;
  if (!plan.shortTermActions.includes(stampDutyAction)) {
    plan.shortTermActions.push(stampDutyAction);
  }

  if (loanAmount > 0) {
    const paperworkAction = "Collect 6 months bank statements + salary proofs for loan pre-approval.";
    if (!plan.immediateActions.includes(paperworkAction)) {
      plan.immediateActions.push(paperworkAction);
    }
  }

  if (!plan.coachNotes.some((note) => note.includes("35%"))) {
    plan.coachNotes.push("Remind EMI must stay ≤35% of income and mention stamp duty buffer explicitly.");
  }

  const diversionAction = `Divert 20% from ${topCategory} spends to grow the down-payment buffer.`;
  if (!plan.shortTermActions.includes(diversionAction)) {
    plan.shortTermActions.push(diversionAction);
  }
}

function collectPersonalizationAnchors(
  session: ChaturCoachingSession,
  transactionData?: TransactionSummary,
  expenseAnalysis?: ExpenseAnalysis,
): string[] {
  const anchors: string[] = [];
  const goalCount = session.goals.length;

  session.goals.forEach((goal, index) => {
    const descriptors: string[] = [];
    if (goal.targetAmount !== undefined) {
      descriptors.push(`target ${formatCurrency(goal.targetAmount)}`);
    }
    if (goal.timeframe?.label) {
      descriptors.push(`timeline: ${goal.timeframe.label}`);
    }
    descriptors.push(`priority: ${goal.priority}`);
    const label = goalCount > 1 ? `Goal ${index + 1} (${goal.summary})` : `Primary goal (${goal.summary})`;
    anchors.push(`${label} → ${descriptors.join(", ")}`);

    const purchaseDetails = goal.purchaseDetails;
    if (purchaseDetails?.affordabilityNote) {
      anchors.push(`Loan readiness: ${purchaseDetails.affordabilityNote}`);
    }
    if (purchaseDetails?.missingInputs && purchaseDetails.missingInputs.length > 0) {
      anchors.push(`Collect loan inputs: ${purchaseDetails.missingInputs.join(", ")}`);
    }
  });

  if (session.actionPlan) {
    if (session.actionPlan.immediate.length > 0) {
      anchors.push(`Immediate plan items: ${session.actionPlan.immediate.slice(0, 3).join("; ")}`);
    }
    if (session.actionPlan.shortTerm.length > 0) {
      anchors.push(`Short-term plan items: ${session.actionPlan.shortTerm.slice(0, 3).join("; ")}`);
    }
  }

  const riskLabels: Record<string, string> = {
    isOverspending: "Overspending risk",
    hasImpulseBuying: "Impulse buying pattern",
    irregularIncome: "Irregular income",
    lowSavings: "Low savings buffer",
  };
  const riskFlags = Object.entries(session.userContext.behavior.riskFlags)
    .filter(([, flagged]) => flagged)
    .map(([key]) => riskLabels[key] ?? key);
  if (riskFlags.length > 0) {
    anchors.push(`Active risk flags: ${riskFlags.join("; ")}`);
  }

  if (session.userContext.behavior.positiveHabits.length > 0) {
    anchors.push(`Positive habits to reinforce: ${session.userContext.behavior.positiveHabits.slice(0, 3).join("; ")}`);
  }
  if (session.userContext.behavior.concerningPatterns.length > 0) {
    anchors.push(`Patterns needing attention: ${session.userContext.behavior.concerningPatterns.slice(0, 3).join("; ")}`);
  }

  if (expenseAnalysis) {
    anchors.push(
      `Monthly savings: ${formatCurrency(expenseAnalysis.netSavings)} (${formatPercent(expenseAnalysis.savingsRate)} savings rate)`,
    );
    if (expenseAnalysis.highSpendCategories.length > 0) {
      anchors.push(`High-spend categories: ${expenseAnalysis.highSpendCategories.slice(0, 3).join(", ")}`);
    }
    if (expenseAnalysis.topVendors.length > 0) {
      const vendorSnippets = expenseAnalysis.topVendors.slice(0, 3).map((vendor) => `${vendor.vendor} ${formatCurrency(vendor.amount)}`);
      anchors.push(`Top vendors driving spend: ${vendorSnippets.join(", ")}`);
    }
  }

  if (transactionData?.transactions?.length) {
    const recentSnippets = transactionData.transactions
      .slice(0, 3)
      .map((tx) => `${tx.date}: ${tx.type === "debit" ? "spent" : "received"} ${formatCurrency(tx.amount)}${tx.targetParty ? ` (${tx.targetParty})` : ""}`);
    anchors.push(`Recent transactions: ${recentSnippets.join(" | ")}`);
  }

  const goalNotes = session.goalCoachingNotes ?? [];
  if (goalNotes.length > 0) {
    anchors.push(`Outstanding coach follow-ups: ${goalNotes.slice(0, 3).join("; ")}`);
  }

  return anchors;
}

function mergeAgentRecommendations(
  current: AgentActionRecommendation[],
  incoming: AgentActionRecommendation[],
): AgentActionRecommendation[] {
  const merged = new Map<string, AgentActionRecommendation>();

  const add = (recommendation: AgentActionRecommendation) => {
    const key = `${recommendation.agent}|${recommendation.action}|${recommendation.relatedGoalId ?? ""}`;
    if (!merged.has(key)) {
      merged.set(key, { ...recommendation });
    } else {
      const existing = merged.get(key)!;
      if (recommendation.reason && !existing.reason.includes(recommendation.reason)) {
        existing.reason = `${existing.reason}; ${recommendation.reason}`;
      }
      if (!existing.cadence && recommendation.cadence) {
        existing.cadence = recommendation.cadence;
      }
    }
  };

  current.forEach(add);
  incoming.forEach(add);

  return Array.from(merged.values());
}

function looksLikePropertyGoal(goal: FinancialGoal): boolean {
  const reference = `${goal.summary} ${goal.rawStatement}`.toLowerCase();
  return /(house|home|apartment|flat|property|villa|plot|land)/.test(reference);
}

function parseAmountString(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  let sanitized = raw.toLowerCase().replace(/₹/g, "").replace(/,/g, "").replace(/\s+/g, "");
  if (sanitized.length === 0) {
    return undefined;
  }

  let multiplier = 1;
  if (sanitized.endsWith("crore") || sanitized.endsWith("cr")) {
    multiplier = 10_000_000;
    sanitized = sanitized.replace(/(crore|cr)$/u, "");
  } else if (sanitized.endsWith("lakhs") || sanitized.endsWith("lakh") || sanitized.endsWith("lac")) {
    multiplier = 100_000;
    sanitized = sanitized.replace(/(lakhs?|lac)$/u, "");
  } else if (sanitized.endsWith("k")) {
    multiplier = 1_000;
    sanitized = sanitized.replace(/k$/u, "");
  }

  const value = Number.parseFloat(sanitized);
  if (!Number.isFinite(value)) {
    return undefined;
  }

  return Math.round(value * multiplier);
}

function parsePercentString(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const sanitized = raw.replace(/[^0-9.]/g, "");
  if (!sanitized) {
    return undefined;
  }

  const value = Number.parseFloat(sanitized);
  return Number.isFinite(value) ? value : undefined;
}

function extractLoanInputsFromQuery(query: string): Partial<PurchaseGoalDetails> {
  const candidates: Partial<PurchaseGoalDetails> = {};

  const downPatterns = [
    /([0-9]+(?:\.[0-9]+)?)\s*%\s*(?:down(?:\s|-)?payment|dp|deposit)/i,
    /down(?:\s|-)?payment(?:\s*(?:of|is|at))?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:percent|%)/i,
  ];
  for (const pattern of downPatterns) {
    const match = query.match(pattern);
    if (match?.[1]) {
      const percent = parsePercentString(match[1]);
      if (percent !== undefined) {
        candidates.downPaymentPercent = percent;
        break;
      }
    }
  }

  const savingsPatterns = [
    /(?:have|got|holding|left\s+with|saved\s+up|put\s+aside)\s*(?:about\s*)?₹?\s*([0-9,\.\s]+(?:k|lac|lakh|crore|cr)?)/i,
    /(?:savings|investments|cash)(?:\s+(?:of|worth|available|ready))?\s*(?:is|are|=)?\s*₹?\s*([0-9,\.\s]+(?:k|lac|lakh|crore|cr)?)/i,
    /(?:can\s+(?:put|pay)|putting)\s*(?:around\s*)?₹?\s*([0-9,\.\s]+(?:k|lac|lakh|crore|cr)?)/i,
  ];
  for (const pattern of savingsPatterns) {
    const match = query.match(pattern);
    if (match?.[1]) {
      const amount = parseAmountString(match[1]);
      if (amount !== undefined) {
        candidates.availableSavings = amount;
        break;
      }
    }
  }

  const ratePatterns = [
    /([0-9]+(?:\.[0-9]+)?)\s*%\s*(?:interest|rate|apr)/i,
    /rate\s*(?:of|at)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:percent|%)/i,
  ];
  for (const pattern of ratePatterns) {
    const match = query.match(pattern);
    if (match?.[1]) {
      const rate = parsePercentString(match[1]);
      if (rate !== undefined) {
        candidates.loanRatePercent = rate;
        break;
      }
    }
  }

  const propertyPatterns = [
    /(property|house|home|apartment|flat|villa|plot|land)\s*(?:price|cost|worth)?\s*(?:is|=|around)?\s*₹?\s*([0-9,\.\s]+(?:k|lac|lakh|crore|cr)?)/i,
    /₹?\s*([0-9,\.\s]+(?:k|lac|lakh|crore|cr)?)\s*(?:property|house|home|apartment|flat|villa|plot|land)/i,
  ];
  for (const pattern of propertyPatterns) {
    const match = query.match(pattern);
    if (match?.[2]) {
      const amount = parseAmountString(match[2]);
      if (amount !== undefined) {
        candidates.propertyPrice = amount;
        break;
      }
    } else if (match?.[1]) {
      const amount = parseAmountString(match[1]);
      if (amount !== undefined) {
        candidates.propertyPrice = amount;
        break;
      }
    }
  }

  return candidates;
}

function buildLoanInputCTA(missing: string[]): string {
  if (missing.length === 0) {
    return "";
  }

  if (missing.length === 1) {
    return `Confirm your ${missing[0]} so I can estimate EMI options.`;
  }

  const last = missing[missing.length - 1];
  const initial = missing.slice(0, -1).join(", ");
  return `Share your ${initial} and ${last} so I can estimate EMI options.`;
}

async function gatherLoanIntelForQuery(goal: FinancialGoal, userQuery: string): Promise<string | undefined> {
  if (goal.type !== "purchase" || !looksLikePropertyGoal(goal)) {
    return undefined;
  }

  const purchaseDetails = goal.purchaseDetails ?? (goal.purchaseDetails = {});
  const topics = determineLoanIntelTopics(userQuery, purchaseDetails);
  if (topics.length === 0) {
    return undefined;
  }

  const location = extractLocationFromQuery(userQuery);
  const now = new Date();
  const monthLabel = now.toLocaleString("en-IN", { month: "long", year: "numeric" });
  const year = now.getFullYear();
  const retrievedAt = now.toISOString();

  const sources: LoanIntelSource[] = [];
  const snippetParts: string[] = ["=== LOAN MARKET SNAPSHOT ==="];

  for (const topic of topics) {
    const queries = buildLoanIntelQueries(topic, location, monthLabel, year);
    const result = await runSearchWithFallbacks(queries);
    if (result) {
      const summary = truncateSummary(formatSearchResults(result.result));
      sources.push({
        topic,
        query: result.query,
        summary,
        retrievedAt,
      });
      snippetParts.push(`Topic: ${topic.replace(/_/g, " ")}`);
      snippetParts.push(`Query Used: ${result.query}`);
      snippetParts.push(summary);
      snippetParts.push("");
    } else {
      snippetParts.push(`Topic: ${topic.replace(/_/g, " ")}`);
      snippetParts.push("Query Used: (no reliable results)");
      snippetParts.push("No reliable live data found. Re-run search later.");
      snippetParts.push("");
    }
  }

  if (sources.length === 0) {
    return undefined;
  }

  purchaseDetails.loanIntelSources = sources;
  purchaseDetails.lastIntelFetchedAt = retrievedAt;

  return snippetParts.join("\n").trim();
}

function determineLoanIntelTopics(
  userQuery: string,
  details?: PurchaseGoalDetails,
): LoanIntelSource["topic"][] {
  const normalized = userQuery.toLowerCase();
  const isLoanIntent = /(loan|emi|mortgage|down payment|property|home|house|flat|villa|stamp duty|rbi|ltv|interest)/i.test(normalized);
  if (!isLoanIntent) {
    return [];
  }

  const topics = new Set<LoanIntelSource["topic"]>();

  const interestKeywords = ["interest rate", "loan rate", "emi", "apr", "roi", "current rate"];
  if (interestKeywords.some((keyword) => normalized.includes(keyword))) {
    topics.add("interest_rate");
  }

  const ruleKeywords = ["rbi", "rule", "regulation", "norm", "ltv", "loan-to-value", "guideline"];
  if (ruleKeywords.some((keyword) => normalized.includes(keyword))) {
    topics.add("ltv_rule");
  }

  const stampKeywords = ["stamp duty", "registration", "registry", "registration charge"];
  if (stampKeywords.some((keyword) => normalized.includes(keyword))) {
    topics.add("stamp_duty");
  }

  const eligibilityKeywords = ["eligibility", "document", "documents", "credit score", "cibil", "proof", "salary slip"];
  if (eligibilityKeywords.some((keyword) => normalized.includes(keyword))) {
    topics.add("eligibility");
  }

  const lastIntelHours = details?.lastIntelFetchedAt ? getHoursSince(details.lastIntelFetchedAt) : undefined;
  const hasIntel = details?.loanIntelSources && details.loanIntelSources.length > 0;
  const intelIsStale = lastIntelHours === undefined || lastIntelHours >= LOAN_INTEL_REFRESH_HOURS;

  if (!hasIntel || intelIsStale) {
    topics.add("interest_rate");
    topics.add("ltv_rule");
  }

  if (topics.size === 0) {
    topics.add("interest_rate");
    topics.add("ltv_rule");
  }

  return Array.from(topics);
}

function buildLoanIntelQueries(
  topic: LoanIntelSource["topic"],
  location: string | undefined,
  monthLabel: string,
  year: number,
): string[] {
  const queries: string[] = [];
  const cleanedLocation = location ? location.trim() : "";

  const baseInterestQueries = () => {
    if (cleanedLocation) {
      queries.push(`current home loan interest rates ${cleanedLocation} ${monthLabel}`);
      queries.push(`latest home loan interest rate ${cleanedLocation} ${year}`);
    }
    queries.push(`current home loan interest rates India ${monthLabel}`);
    queries.push(`latest home loan interest rates India ${year}`);
    queries.push(`RBI repo rate impact on home loan ${monthLabel}`);
  };

  const baseRuleQueries = () => {
    queries.push(`RBI home loan LTV rules ${year}`);
    queries.push(`RBI loan to value norms ${year}`);
    queries.push(`home loan regulation updates India ${year}`);
  };

  const baseStampQueries = () => {
    const target = cleanedLocation || "India";
    queries.push(`stamp duty rates ${target} ${year}`);
    queries.push(`registration charges ${target} ${year}`);
    queries.push(`property registration cost ${target} ${year}`);
  };

  const baseEligibilityQueries = () => {
    const target = cleanedLocation || "India";
    queries.push(`home loan eligibility criteria ${target} ${year}`);
    queries.push(`home loan documents required ${target} ${year}`);
    queries.push(`minimum cibil score home loan ${year}`);
  };

  switch (topic) {
    case "interest_rate":
      baseInterestQueries();
      break;
    case "ltv_rule":
      baseRuleQueries();
      break;
    case "stamp_duty":
      baseStampQueries();
      break;
    case "eligibility":
      baseEligibilityQueries();
      break;
    default:
      baseInterestQueries();
      baseRuleQueries();
      break;
  }

  const uniqueQueries = Array.from(new Set(queries.map(normalizeWhitespace)));
  return uniqueQueries.filter((query) => query.length > 0);
}

function extractLocationFromQuery(query: string): string | undefined {
  const locationMatch = query.match(/\b(?:in|at)\s+([A-Za-z]{2,}(?:\s+[A-Za-z]{2,}){0,2})/i);
  if (!locationMatch || !locationMatch[1]) {
    return undefined;
  }

  const rawLocation = locationMatch[1].replace(/[^A-Za-z\s]/g, " ").trim();
  if (!rawLocation) {
    return undefined;
  }

  const words = rawLocation.split(/\s+/);
  if (words.length > 3) {
    return undefined;
  }

  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

async function runSearchWithFallbacks(queries: string[]): Promise<{ query: string; result: WebSearchResult } | null> {
  for (const raw of queries) {
    const query = normalizeWhitespace(raw);
    if (!query) {
      continue;
    }
    try {
      const result = await searchWeb(query, 3);
      if (result.totalResults > 0) {
        return { query, result };
      }
    } catch (error) {
      console.error(`[chatur] Loan intel search failed for "${query}":`, error);
    }
  }
  return null;
}

function truncateSummary(summary: string, limit = 900): string {
  const trimmed = summary.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit)}…`;
}

function getHoursSince(isoTimestamp: string): number | undefined {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  const diffMs = Date.now() - parsed;
  return diffMs / 3_600_000;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseCurrencyAmount(query: string): number | undefined {
  const normalized = query.replace(/,/g, "").trim();
  const patterns = [
    /(?:₹|inr|rs\.?)?\s*(\d+(?:\.\d+)?)\s*(k|lakhs?|lac|crore|cr)?/i,
    /(\d+(?:\.\d+)?)(k|lakhs?|lac|crore|cr)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      let value = Number.parseFloat(match[1]);
      if (Number.isNaN(value)) {
        continue;
      }

      const modifier = match[2]?.toLowerCase();
      switch (modifier) {
        case "k":
          value *= 1_000;
          break;
        case "lac":
        case "lakh":
        case "lakhs":
          value *= 100_000;
          break;
        case "crore":
        case "cr":
          value *= 10_000_000;
          break;
        default:
          break;
      }

      return value;
    }
  }

  return undefined;
}

function ensureCoachDisclaimer(response: string): string {
  const trimmed = response.trim();
  const content = trimmed.length > 0 ? trimmed : "I need more details to personalise the plan.";
  const lower = content.toLowerCase();

  const disclaimerSegments: string[] = [];
  if (!lower.includes("i'm an ai")) {
    disclaimerSegments.push("⚠️ I'm an AI financial coach and may miss context.");
  }
  if (!lower.includes("not professional advice")) {
    disclaimerSegments.push("Not professional advice—consult experts.");
  }
  if (!lower.includes("professional") || !lower.includes("help")) {
    disclaimerSegments.push("Please double-check sensitive money choices with a human professional.");
  }

  if (disclaimerSegments.length === 0) {
    return content;
  }

  return `${content}\n\n${disclaimerSegments.join(" ")}`.trim();
}

function parseGoalTimeframe(query: string): GoalTimeframe | undefined {
  const lower = query.toLowerCase();
  const now = new Date();

  if (/next\s+year/.test(lower)) {
    const target = addMonths(now, 12);
    return { label: "next year", months: 12, targetDate: target.toISOString().slice(0, 10) };
  }

  if (/next\s+month/.test(lower)) {
    const target = addMonths(now, 1);
    return { label: "next month", months: 1, targetDate: target.toISOString().slice(0, 10) };
  }

  const nextRangeMatch = lower.match(/next\s+(\d+)\s+(week|weeks|month|months|year|years)/);
  if (nextRangeMatch) {
    const valueRaw = nextRangeMatch[1];
    const unitRaw = nextRangeMatch[2];
    if (valueRaw && unitRaw) {
      const value = Number.parseInt(valueRaw, 10);
      if (!Number.isNaN(value)) {
        const months = convertToMonths(value, unitRaw);
        const target = unitRaw.startsWith("week") ? addDays(now, value * 7) : addMonths(now, months);
        return {
          label: `next ${value} ${unitRaw}`,
          months,
          targetDate: target.toISOString().slice(0, 10),
        };
      }
    }
  }

  const inMatch = lower.match(/(?:in|within)\s+(\d+)\s+(week|weeks|month|months|year|years)/);
  if (inMatch) {
    const valueRaw = inMatch[1];
    const unitRaw = inMatch[2];
    if (valueRaw && unitRaw) {
      const value = Number.parseInt(valueRaw, 10);
      if (!Number.isNaN(value)) {
        const months = convertToMonths(value, unitRaw);
        const target = unitRaw.startsWith("week") ? addDays(now, value * 7) : addMonths(now, months);
        return {
          label: `in ${value} ${unitRaw}`,
          months,
          targetDate: target.toISOString().slice(0, 10),
        };
      }
    }
  }

  const byYearMatch = lower.match(/by\s+(20\d{2})/);
  if (byYearMatch) {
    const targetYearRaw = byYearMatch[1];
    if (targetYearRaw) {
      const targetYear = Number.parseInt(targetYearRaw, 10);
      const target = new Date(targetYear, 0, 1);
      if (target > now) {
        const months = (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
        if (months > 0) {
          return {
            label: `by ${targetYear}`,
            months,
            targetDate: target.toISOString().slice(0, 10),
          };
        }
      }
    }
  }

  return undefined;
}

function convertToMonths(value: number, unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized.startsWith("week")) {
    return Math.max(1, Math.ceil((value * 7) / 30));
  }
  if (normalized.startsWith("year")) {
    return value * 12;
  }
  return value;
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setMonth(result.getMonth() + months);
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

function buildGoalSummary(
  type: FinancialGoal["type"],
  targetItem: string | undefined,
  targetAmount: number | undefined,
  timeframe: GoalTimeframe | undefined,
  fallback: string,
): string {
  if (type === "purchase") {
    if (targetItem) {
      const itemName = capitalize(targetItem);
      return timeframe?.label ? `Buy ${itemName} (${timeframe.label})` : `Buy ${itemName}`;
    }
    return timeframe?.label ? `Major purchase (${timeframe.label})` : "Major purchase";
  }

  if (type === "savings" && targetAmount) {
    return timeframe?.label
      ? `Save ${formatCurrency(targetAmount)} (${timeframe.label})`
      : `Save ${formatCurrency(targetAmount)}`;
  }

  if (type === "debt_repayment") {
    return targetAmount ? `Pay off debt (${formatCurrency(targetAmount)})` : "Pay off debt";
  }

  if (type === "income_growth") {
    return "Increase income";
  }

  if (fallback.length > 60) {
    return `${fallback.slice(0, 57)}...`;
  }

  return fallback;
}

function deriveGoalPriority(timeframe?: GoalTimeframe): FinancialGoal["priority"] {
  if (!timeframe?.months) {
    return "medium";
  }

  if (timeframe.months <= 6) {
    return "high";
  }

  if (timeframe.months <= 12) {
    return "medium";
  }

  return "low";
}

function generateGoalId(): string {
  return `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function capitalize(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}
