/**
 * Financial Calculator Tools for Chatur
 * 
 * Provides accurate mathematical calculations for:
 * - Savings goals (daily/weekly/monthly)
 * - Compound interest
 * - Budgeting and allocations
 * - Affordability assessments
 * - Emergency fund planning
 * - Debt payoff calculations
 */

export interface SavingsGoalCalculation {
  targetAmount: number;
  currentSavings: number;
  timeframeMonths: number;
  
  // Calculated values
  totalNeeded: number;
  monthlyRequired: number;
  weeklyRequired: number;
  dailyRequired: number;
  
  // Context
  isAchievable: boolean;
  recommendedAdjustment?: {
    type: "increase_timeframe" | "reduce_target" | "increase_income";
    suggestion: string;
  } | undefined;
}

export interface BudgetAllocation {
  income: number;
  
  // 50/30/20 rule
  needs: number;          // 50%
  wants: number;          // 30%
  savings: number;        // 20%
  
  // Emergency fund target (3-6 months)
  emergencyFundMin: number;
  emergencyFundMax: number;
}

export interface CompoundInterestResult {
  principal: number;
  rate: number;           // Annual rate (e.g., 0.08 for 8%)
  timeYears: number;
  monthlyContribution: number;
  
  // Calculated
  futureValue: number;
  totalContributed: number;
  totalInterest: number;
  monthlyBreakdown?: Array<{
    month: number;
    balance: number;
    interestEarned: number;
  }> | undefined;
}

export interface DebtPayoffPlan {
  principal: number;
  interestRate: number;   // Annual rate
  monthlyPayment: number;
  
  // Calculated
  monthsToPayoff: number;
  totalInterestPaid: number;
  totalAmountPaid: number;
  
  // Recommendations
  minimumPayment: number;
  recommendedPayment: number;
  savedByPayingMore?: number | undefined;
}

export interface AffordabilityCheck {
  itemCost: number;
  monthlyIncome: number;
  currentSavings: number;
  monthlyExpenses: number;
  
  // Calculated
  percentOfIncome: number;
  percentOfSavings: number;
  canAffordNow: boolean;
  monthsToSave: number;
  impactOnEmergencyFund: boolean;
  
  recommendation: "buy_now" | "save_first" | "reconsider";
  reason: string;
}

/**
 * Calculate daily/weekly/monthly savings needed to reach a goal
 */
export function calculateSavingsGoal(
  targetAmount: number,
  currentSavings: number,
  timeframeMonths: number,
  monthlyIncome: number,
): SavingsGoalCalculation {
  const totalNeeded = Math.max(0, targetAmount - currentSavings);
  const monthlyRequired = totalNeeded / timeframeMonths;
  const weeklyRequired = (monthlyRequired * 12) / 52;
  const dailyRequired = monthlyRequired / 30;
  
  // Check if achievable (shouldn't exceed 30% of income)
  const percentOfIncome = (monthlyRequired / monthlyIncome) * 100;
  const isAchievable = percentOfIncome <= 30;
  
  let recommendedAdjustment: SavingsGoalCalculation["recommendedAdjustment"];
  
  if (!isAchievable) {
    if (percentOfIncome > 50) {
      recommendedAdjustment = {
        type: "increase_timeframe",
        suggestion: `Try extending to ${Math.ceil(totalNeeded / (monthlyIncome * 0.3))} months to keep savings rate under 30% of income`,
      };
    } else if (percentOfIncome > 40) {
      recommendedAdjustment = {
        type: "reduce_target",
        suggestion: `Consider a target of ₹${Math.floor(monthlyIncome * 0.3 * timeframeMonths + currentSavings)} instead`,
      };
    } else {
      recommendedAdjustment = {
        type: "increase_income",
        suggestion: `Look for ways to boost income by ₹${Math.ceil(monthlyRequired - monthlyIncome * 0.3)} per month`,
      };
    }
  }
  
  return {
    targetAmount,
    currentSavings,
    timeframeMonths,
    totalNeeded,
    monthlyRequired,
    weeklyRequired,
    dailyRequired,
    isAchievable,
    recommendedAdjustment,
  };
}

/**
 * Calculate budget allocation using 50/30/20 rule
 */
export function calculateBudgetAllocation(monthlyIncome: number): BudgetAllocation {
  return {
    income: monthlyIncome,
    needs: monthlyIncome * 0.5,      // 50% - rent, food, utilities
    wants: monthlyIncome * 0.3,      // 30% - entertainment, dining out
    savings: monthlyIncome * 0.2,    // 20% - savings and investments
    emergencyFundMin: monthlyIncome * 3,  // 3 months of expenses
    emergencyFundMax: monthlyIncome * 6,  // 6 months of expenses
  };
}

/**
 * Calculate compound interest with monthly contributions
 */
export function calculateCompoundInterest(
  principal: number,
  annualRate: number,
  years: number,
  monthlyContribution: number = 0,
  includeBreakdown: boolean = false,
): CompoundInterestResult {
  const monthlyRate = annualRate / 12;
  const months = years * 12;
  
  let balance = principal;
  let totalContributed = principal;
  const breakdown: Array<{ month: number; balance: number; interestEarned: number }> = [];
  
  for (let month = 1; month <= months; month++) {
    const interestEarned = balance * monthlyRate;
    balance += interestEarned + monthlyContribution;
    totalContributed += monthlyContribution;
    
    if (includeBreakdown && (month % 12 === 0 || month === months)) {
      breakdown.push({
        month,
        balance: Math.round(balance * 100) / 100,
        interestEarned: Math.round(interestEarned * 100) / 100,
      });
    }
  }
  
  return {
    principal,
    rate: annualRate,
    timeYears: years,
    monthlyContribution,
    futureValue: Math.round(balance * 100) / 100,
    totalContributed: Math.round(totalContributed * 100) / 100,
    totalInterest: Math.round((balance - totalContributed) * 100) / 100,
    monthlyBreakdown: includeBreakdown ? breakdown : undefined,
  };
}

/**
 * Calculate debt payoff plan
 */
export function calculateDebtPayoff(
  principal: number,
  annualRate: number,
  monthlyPayment: number,
): DebtPayoffPlan {
  const monthlyRate = annualRate / 12;
  
  // Calculate minimum payment (1% of principal + interest)
  const minimumPayment = Math.max(
    principal * 0.01 + principal * monthlyRate,
    principal * monthlyRate * 2, // At least 2x interest to make progress
  );
  
  // Calculate recommended payment (pay off in 2-3 years)
  const recommendedMonths = 30; // 2.5 years
  const recommendedPayment = (principal * (monthlyRate * Math.pow(1 + monthlyRate, recommendedMonths))) /
                              (Math.pow(1 + monthlyRate, recommendedMonths) - 1);
  
  // Calculate actual payoff
  let balance = principal;
  let months = 0;
  let totalInterest = 0;
  const maxMonths = 600; // 50 years safety limit
  
  while (balance > 0.01 && months < maxMonths) {
    const interestCharge = balance * monthlyRate;
    totalInterest += interestCharge;
    
    const principalPayment = Math.min(monthlyPayment - interestCharge, balance);
    balance -= principalPayment;
    months++;
    
    // If payment doesn't cover interest, debt will never be paid off
    if (principalPayment <= 0) {
      months = Infinity;
      break;
    }
  }
  
  // Calculate savings by paying recommended amount
  let savedInterest = 0;
  if (monthlyPayment < recommendedPayment && months !== Infinity) {
    const optimalResult = calculateDebtPayoff(principal, annualRate, recommendedPayment);
    savedInterest = totalInterest - optimalResult.totalInterestPaid;
  }
  
  return {
    principal,
    interestRate: annualRate,
    monthlyPayment,
    monthsToPayoff: months,
    totalInterestPaid: Math.round(totalInterest * 100) / 100,
    totalAmountPaid: Math.round((principal + totalInterest) * 100) / 100,
    minimumPayment: Math.round(minimumPayment * 100) / 100,
    recommendedPayment: Math.round(recommendedPayment * 100) / 100,
    savedByPayingMore: savedInterest > 0 ? Math.round(savedInterest * 100) / 100 : undefined,
  };
}

/**
 * Check if user can afford a purchase
 */
export function checkAffordability(
  itemCost: number,
  monthlyIncome: number,
  currentSavings: number,
  monthlyExpenses: number,
): AffordabilityCheck {
  const disposableIncome = monthlyIncome - monthlyExpenses;
  const percentOfIncome = (itemCost / monthlyIncome) * 100;
  const percentOfSavings = currentSavings > 0 ? (itemCost / currentSavings) * 100 : Infinity;
  
  // Emergency fund threshold (3 months)
  const emergencyFund = monthlyExpenses * 3;
  const remainingAfterPurchase = currentSavings - itemCost;
  const impactOnEmergencyFund = remainingAfterPurchase < emergencyFund;
  
  // Can afford now if: has savings, doesn't dip emergency fund, <10% of income
  const canAffordNow = 
    currentSavings >= itemCost &&
    !impactOnEmergencyFund &&
    percentOfIncome <= 10;
  
  // Months to save if needed
  const monthsToSave = disposableIncome > 0 
    ? Math.ceil((itemCost - currentSavings) / (disposableIncome * 0.3))
    : Infinity;
  
  // Determine recommendation
  let recommendation: AffordabilityCheck["recommendation"];
  let reason: string;
  
  if (canAffordNow) {
    recommendation = "buy_now";
    reason = `You can afford this—it's only ${percentOfIncome.toFixed(1)}% of monthly income and won't impact emergency savings`;
  } else if (impactOnEmergencyFund) {
    recommendation = "save_first";
    reason = `This would dip your emergency fund. Save for ${monthsToSave} months (₹${Math.ceil((itemCost - currentSavings) / monthsToSave)}/month)`;
  } else if (percentOfIncome > 30) {
    recommendation = "reconsider";
    reason = `This is ${percentOfIncome.toFixed(0)}% of monthly income—too high. Consider alternatives or increase income first`;
  } else {
    recommendation = "save_first";
    reason = `Save ₹${Math.ceil((itemCost - currentSavings) / monthsToSave)}/month for ${monthsToSave} months to buy comfortably`;
  }
  
  return {
    itemCost,
    monthlyIncome,
    currentSavings,
    monthlyExpenses,
    percentOfIncome,
    percentOfSavings,
    canAffordNow,
    monthsToSave,
    impactOnEmergencyFund,
    recommendation,
    reason,
  };
}

/**
 * Calculate daily spending budget
 */
export function calculateDailyBudget(
  monthlyIncome: number,
  fixedExpenses: number,
  savingsGoal: number,
): {
  dailyBudget: number;
  weeklyBudget: number;
  monthlyDiscretionary: number;
  breakdown: {
    income: number;
    fixed: number;
    savings: number;
    discretionary: number;
  };
} {
  const discretionary = monthlyIncome - fixedExpenses - savingsGoal;
  const dailyBudget = discretionary / 30;
  const weeklyBudget = (discretionary * 12) / 52;
  
  return {
    dailyBudget: Math.round(dailyBudget * 100) / 100,
    weeklyBudget: Math.round(weeklyBudget * 100) / 100,
    monthlyDiscretionary: Math.round(discretionary * 100) / 100,
    breakdown: {
      income: monthlyIncome,
      fixed: fixedExpenses,
      savings: savingsGoal,
      discretionary,
    },
  };
}

/**
 * Calculate percentage change
 */
export function calculatePercentageChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) return newValue > 0 ? 100 : 0;
  return ((newValue - oldValue) / oldValue) * 100;
}

/**
 * Calculate average
 */
export function calculateAverage(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, val) => sum + val, 0) / values.length;
}

/**
 * Format currency
 */
export function formatCurrency(amount: number, currency: string = "₹"): string {
  const rounded = Math.round(amount * 100) / 100;
  const formatted = rounded.toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return `${currency}${formatted}`;
}

/**
 * Format percentage
 */
export function formatPercentage(value: number, decimals: number = 1): string {
  return `${value.toFixed(decimals)}%`;
}
