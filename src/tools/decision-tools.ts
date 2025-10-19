/**
 * Decision-Making Tools for Chatur
 * 
 * Provides affordability assessments and specific cut-down suggestions
 * based on expense analysis and income data.
 */

import type { Transaction } from "../runtime/param/habit-tracker.js";
import { analyzeExpenses, type ExpenseAnalysis, formatCurrency } from "./expense-analyzer.js";

export interface PurchaseAssessment {
  canAfford: boolean;
  affordabilityScore: number; // 0-100
  recommendation: "good" | "caution" | "avoid";
  reason: string;
  impactOnBudget: number; // Percentage of monthly income
  requiredSavings: {
    perDay: number;
    perWeek: number;
    perMonth: number;
  };
  suggestedCuts?: CutSuggestion[] | undefined;
}

export interface CutSuggestion {
  category: string;
  currentSpend: number;
  suggestedReduction: number;
  savedAmount: number;
  specificAction: string;
  reason: string;
  priority: "high" | "medium" | "low";
}

export interface AffordabilityOptions {
  purchaseAmount: number;
  timeframeMonths?: number; // How many months to save
  currentSavings?: number; // Existing savings
  minSavingsBuffer?: number; // Minimum savings to maintain (default 10% of income)
}

/**
 * Assess if a purchase is affordable and provide recommendations
 */
export function assessPurchase(
  transactions: Transaction[],
  options: AffordabilityOptions
): PurchaseAssessment {
  const analysis = analyzeExpenses(transactions);
  const { purchaseAmount, timeframeMonths = 1, currentSavings = 0, minSavingsBuffer = 0.1 } = options;

  const monthlyIncome = analysis.monthlyIncome;
  const monthlyExpenses = analysis.monthlyExpenses;
  const currentMonthlySavings = monthlyIncome - monthlyExpenses;

  // Calculate if affordable
  const impactOnBudget = monthlyIncome > 0 ? (purchaseAmount / monthlyIncome) * 100 : 100;
  const requiredMonthlySavings = (purchaseAmount - currentSavings) / timeframeMonths;
  const requiredDailySavings = requiredMonthlySavings / 30;
  const requiredWeeklySavings = requiredMonthlySavings / 4;

  // Affordability score (0-100)
  let affordabilityScore = 100;
  
  // Factor 1: Impact on budget (should be <10% for good, <20% for caution)
  if (impactOnBudget > 20) {
    affordabilityScore -= 40;
  } else if (impactOnBudget > 10) {
    affordabilityScore -= 20;
  }

  // Factor 2: Current savings vs required
  const savingsShortfall = requiredMonthlySavings - currentMonthlySavings;
  if (savingsShortfall > 0) {
    const shortfallPercentage = (savingsShortfall / monthlyIncome) * 100;
    affordabilityScore -= Math.min(40, shortfallPercentage * 2);
  }

  // Factor 3: Maintains savings buffer
  const bufferAmount = monthlyIncome * minSavingsBuffer;
  if (currentMonthlySavings - requiredMonthlySavings < bufferAmount) {
    affordabilityScore -= 20;
  }

  affordabilityScore = Math.max(0, affordabilityScore);

  // Recommendation
  let recommendation: "good" | "caution" | "avoid";
  if (affordabilityScore >= 70) {
    recommendation = "good";
  } else if (affordabilityScore >= 40) {
    recommendation = "caution";
  } else {
    recommendation = "avoid";
  }

  // Reason
  let reason = "";
  if (recommendation === "good") {
    reason = `Purchase is ${formatCurrency(purchaseAmount)} (${impactOnBudget.toFixed(1)}% of monthly income). You're currently saving ${formatCurrency(currentMonthlySavings)}/month, which covers this comfortably.`;
  } else if (recommendation === "caution") {
    reason = `Purchase is ${formatCurrency(purchaseAmount)} (${impactOnBudget.toFixed(1)}% of monthly income). You need to save ${formatCurrency(requiredMonthlySavings)}/month but currently saving ${formatCurrency(currentMonthlySavings)}/month. Consider cutting expenses.`;
  } else {
    reason = `Purchase is ${formatCurrency(purchaseAmount)} (${impactOnBudget.toFixed(1)}% of monthly income). This is too high compared to your current income ${formatCurrency(monthlyIncome)}/month and expenses ${formatCurrency(monthlyExpenses)}/month. Need significant cuts or longer timeframe.`;
  }

  const canAfford = affordabilityScore >= 40 && currentMonthlySavings > 0;

  // Suggest cuts if needed
  const suggestedCuts = savingsShortfall > 0 
    ? suggestCuts(analysis, savingsShortfall)
    : undefined;

  return {
    canAfford,
    affordabilityScore,
    recommendation,
    reason,
    impactOnBudget,
    requiredSavings: {
      perDay: requiredDailySavings,
      perWeek: requiredWeeklySavings,
      perMonth: requiredMonthlySavings,
    },
    suggestedCuts,
  };
}

/**
 * Suggest specific cuts to reach a savings target
 */
export function suggestCuts(
  analysis: ExpenseAnalysis,
  targetSavings: number
): CutSuggestion[] {
  const suggestions: CutSuggestion[] = [];
  let remainingTarget = targetSavings;

  // Sort categories by potential for savings (high spend + discretionary)
  const sortedCategories = [...analysis.categoryBreakdowns].sort((a, b) => {
    // Prioritize categories with high spend and discretionary nature
    const aPriority = getCategoryPriority(a.category, a.percentage);
    const bPriority = getCategoryPriority(b.category, b.percentage);
    return bPriority - aPriority;
  });

  for (const category of sortedCategories) {
    if (remainingTarget <= 0) break;

    const cutSuggestion = getCategoryCutSuggestion(category.category, category, analysis);
    if (cutSuggestion && cutSuggestion.savedAmount > 0) {
      suggestions.push(cutSuggestion);
      remainingTarget -= cutSuggestion.savedAmount;
    }
  }

  // Sort by priority and amount saved
  return suggestions.sort((a, b) => {
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return b.savedAmount - a.savedAmount;
  });
}

/**
 * Get priority score for a category (higher = more discretionary/cuttable)
 */
function getCategoryPriority(category: string, percentage: number): number {
  const categoryLower = category.toLowerCase();
  
  // Essential categories (lower priority for cuts)
  if (categoryLower.includes("rent") || categoryLower.includes("utilities")) {
    return percentage * 0.2; // Low priority
  }
  
  if (categoryLower.includes("grocery") || categoryLower.includes("groceries")) {
    return percentage * 0.5; // Medium-low priority
  }

  // Discretionary categories (higher priority for cuts)
  if (categoryLower.includes("food") || categoryLower.includes("dining") || 
      categoryLower.includes("eating") || categoryLower.includes("restaurant")) {
    return percentage * 1.5; // High priority
  }

  if (categoryLower.includes("travel") || categoryLower.includes("transport") ||
      categoryLower.includes("cab") || categoryLower.includes("uber") || categoryLower.includes("ola")) {
    return percentage * 1.3; // High priority
  }

  if (categoryLower.includes("entertainment") || categoryLower.includes("subscription")) {
    return percentage * 1.2; // Medium-high priority
  }

  if (categoryLower.includes("shopping") || categoryLower.includes("clothes") ||
      categoryLower.includes("fashion")) {
    return percentage * 1.1; // Medium-high priority
  }

  return percentage * 0.8; // Default medium priority
}

/**
 * Get specific cut suggestion for a category
 */
function getCategoryCutSuggestion(
  categoryName: string,
  category: any,
  analysis: ExpenseAnalysis
): CutSuggestion | null {
  const categoryLower = categoryName.toLowerCase();
  const currentSpend = category.total;
  const monthlySpend = currentSpend; // Assuming analysis is for one month

  // Food/Dining - Check for delivery services
  if (categoryLower.includes("food") || categoryLower.includes("dining") || 
      categoryLower.includes("eating")) {
    const hasDelivery = category.vendors.some((v: any) => 
      v.vendor.toLowerCase().includes("domino") ||
      v.vendor.toLowerCase().includes("swiggy") ||
      v.vendor.toLowerCase().includes("zomato") ||
      v.vendor.toLowerCase().includes("uber eats")
    );

    if (hasDelivery) {
      const deliverySpend = category.vendors
        .filter((v: any) => 
          v.vendor.toLowerCase().includes("domino") ||
          v.vendor.toLowerCase().includes("swiggy") ||
          v.vendor.toLowerCase().includes("zomato")
        )
        .reduce((sum: number, v: any) => sum + v.amount, 0);

      const savedAmount = deliverySpend * 0.6; // Can save 60% by cooking
      return {
        category: categoryName,
        currentSpend,
        suggestedReduction: 60,
        savedAmount,
        specificAction: `Cook home-made meals instead of ordering from Swiggy/Zomato/Domino's`,
        reason: `Food delivery costs ${formatCurrency(deliverySpend)}/month. Home-made meals cost 60% less and are healthier.`,
        priority: category.percentage > 30 ? "high" : "medium",
      };
    }

    // General food reduction
    if (category.percentage > 35) {
      return {
        category: categoryName,
        currentSpend,
        suggestedReduction: 30,
        savedAmount: monthlySpend * 0.3,
        specificAction: `Reduce eating out to 1-2 times per week, cook more at home`,
        reason: `Food spending at ${category.percentage.toFixed(1)}% is high (target: 25-30% of expenses).`,
        priority: "high",
      };
    }
  }

  // Transportation - Check for cab usage
  if (categoryLower.includes("travel") || categoryLower.includes("transport") ||
      categoryLower.includes("cab")) {
    const hasCabs = category.vendors.some((v: any) => 
      v.vendor.toLowerCase().includes("uber") ||
      v.vendor.toLowerCase().includes("ola") ||
      v.vendor.toLowerCase().includes("rapido") ||
      v.vendor.toLowerCase().includes("cab")
    );

    if (hasCabs) {
      const cabSpend = category.vendors
        .filter((v: any) => 
          v.vendor.toLowerCase().includes("uber") ||
          v.vendor.toLowerCase().includes("ola") ||
          v.vendor.toLowerCase().includes("rapido") ||
          v.vendor.toLowerCase().includes("cab")
        )
        .reduce((sum: number, v: any) => sum + v.amount, 0);

      const savedAmount = cabSpend * 0.5; // Can save 50% by using public transport
      return {
        category: categoryName,
        currentSpend,
        suggestedReduction: 50,
        savedAmount,
        specificAction: `Switch to bus/metro for daily commute instead of Uber/Ola`,
        reason: `Cab expenses are ${formatCurrency(cabSpend)}/month. Public transport costs 50% less (bus: ₹30-50 vs cab: ₹150-300 per trip).`,
        priority: cabSpend > 1000 ? "high" : "medium",
      };
    }
  }

  // Entertainment/Subscriptions
  if (categoryLower.includes("entertainment") || categoryLower.includes("subscription")) {
    if (monthlySpend > 500) {
      return {
        category: categoryName,
        currentSpend,
        suggestedReduction: 40,
        savedAmount: monthlySpend * 0.4,
        specificAction: `Cancel unused subscriptions (Netflix, Prime, Spotify), keep only 1-2 essential ones`,
        reason: `Review ${category.transactionCount} subscriptions for unused services. Most people actively use only 1-2 subscriptions.`,
        priority: "medium",
      };
    }
  }

  // Shopping
  if (categoryLower.includes("shopping") || categoryLower.includes("clothes") ||
      categoryLower.includes("fashion")) {
    if (monthlySpend > 2000) {
      return {
        category: categoryName,
        currentSpend,
        suggestedReduction: 50,
        savedAmount: monthlySpend * 0.5,
        specificAction: `Limit non-essential shopping to once per month, make a shopping list before buying`,
        reason: `Shopping at ${formatCurrency(monthlySpend)}/month can be reduced with planned purchases.`,
        priority: category.percentage > 20 ? "high" : "medium",
      };
    }
  }

  // High percentage categories (generic advice)
  if (category.percentage > 40) {
    return {
      category: categoryName,
      currentSpend,
      suggestedReduction: 25,
      savedAmount: monthlySpend * 0.25,
      specificAction: `Reduce ${categoryName} spending by tracking each expense and finding alternatives`,
      reason: `${categoryName} is ${category.percentage.toFixed(1)}% of total expenses (very high). Target: keep below 30%.`,
      priority: "high",
    };
  }

  return null;
}

/**
 * Quick affordability check for conversational use
 */
export function quickAffordabilityCheck(
  monthlyIncome: number,
  monthlyExpenses: number,
  purchaseAmount: number
): { canAfford: boolean; recommendation: string } {
  const monthlySavings = monthlyIncome - monthlyExpenses;
  const impactPercentage = (purchaseAmount / monthlyIncome) * 100;

  if (impactPercentage < 10 && monthlySavings > purchaseAmount) {
    return {
      canAfford: true,
      recommendation: `Yes, looks good! This is only ${impactPercentage.toFixed(1)}% of your income and you're saving enough.`,
    };
  } else if (impactPercentage < 20 && monthlySavings > purchaseAmount * 0.5) {
    return {
      canAfford: true,
      recommendation: `Doable with caution. This is ${impactPercentage.toFixed(1)}% of your income. Consider saving for 1-2 months.`,
    };
  } else {
    return {
      canAfford: false,
      recommendation: `This is ${impactPercentage.toFixed(1)}% of your income—too high. Let's make a savings plan with specific cuts.`,
    };
  }
}
