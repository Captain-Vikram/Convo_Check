/**
 * Test Financial Calculations
 * Quick demonstration of the calculation tools
 */

import {
  calculateSavingsGoal,
  calculateDailyBudget,
  calculateBudgetAllocation,
  checkAffordability,
  formatCurrency,
} from "./dist/tools/financial-calculator.js";

console.log("🧮 FINANCIAL CALCULATOR TESTS\n");
console.log("=" .repeat(60));

// Test 1: Savings Goal
console.log("\n📊 Test 1: Savings Goal Calculation");
console.log("Query: 'How much should I save daily to reach ₹10,000 in 6 months?'");
console.log("-".repeat(60));

const savingsGoal = calculateSavingsGoal(
  10000,    // target amount
  2340,     // current savings
  6,        // timeframe in months
  20000     // monthly income
);

console.log(`Target: ${formatCurrency(savingsGoal.targetAmount)}`);
console.log(`Current Savings: ${formatCurrency(savingsGoal.currentSavings)}`);
console.log(`Need to Save: ${formatCurrency(savingsGoal.totalNeeded)}`);
console.log(`\nRequired Savings:`);
console.log(`  • Daily: ${formatCurrency(savingsGoal.dailyRequired)}`);
console.log(`  • Weekly: ${formatCurrency(savingsGoal.weeklyRequired)}`);
console.log(`  • Monthly: ${formatCurrency(savingsGoal.monthlyRequired)}`);
console.log(`\nAchievable: ${savingsGoal.isAchievable ? "✅ Yes" : "⚠️ Challenging"}`);
if (savingsGoal.recommendedAdjustment) {
  console.log(`Suggestion: ${savingsGoal.recommendedAdjustment.suggestion}`);
}

// Test 2: Daily Budget
console.log("\n\n📊 Test 2: Daily Budget Calculation");
console.log("Query: 'How much can I spend daily if I want to save ₹4,000/month?'");
console.log("-".repeat(60));

const dailyBudget = calculateDailyBudget(
  20000,    // monthly income
  10000,    // fixed expenses (rent, utilities, etc)
  4000      // savings goal
);

console.log(`Monthly Income: ${formatCurrency(dailyBudget.breakdown.income)}`);
console.log(`Fixed Expenses: ${formatCurrency(dailyBudget.breakdown.fixed)}`);
console.log(`Savings Goal: ${formatCurrency(dailyBudget.breakdown.savings)}`);
console.log(`Discretionary: ${formatCurrency(dailyBudget.breakdown.discretionary)}`);
console.log(`\nYour Spending Budget:`);
console.log(`  • Daily: ${formatCurrency(dailyBudget.dailyBudget)}`);
console.log(`  • Weekly: ${formatCurrency(dailyBudget.weeklyBudget)}`);

// Test 3: Budget Allocation (50/30/20 Rule)
console.log("\n\n📊 Test 3: Budget Allocation (50/30/20 Rule)");
console.log("Query: 'How should I divide my ₹25,000 monthly income?'");
console.log("-".repeat(60));

const allocation = calculateBudgetAllocation(25000);

console.log(`Monthly Income: ${formatCurrency(allocation.income)}`);
console.log(`\nRecommended Allocation:`);
console.log(`  • Needs (50%): ${formatCurrency(allocation.needs)}`);
console.log(`    (Rent, food, utilities, transport)`);
console.log(`  • Wants (30%): ${formatCurrency(allocation.wants)}`);
console.log(`    (Entertainment, dining out, hobbies)`);
console.log(`  • Savings (20%): ${formatCurrency(allocation.savings)}`);
console.log(`    (Emergency fund, investments, goals)`);
console.log(`\nEmergency Fund Target:`);
console.log(`  • Minimum (3 months): ${formatCurrency(allocation.emergencyFundMin)}`);
console.log(`  • Ideal (6 months): ${formatCurrency(allocation.emergencyFundMax)}`);

// Test 4: Affordability Check
console.log("\n\n📊 Test 4: Affordability Check");
console.log("Query: 'Can I afford to buy a ₹15,000 phone?'");
console.log("-".repeat(60));

const affordability = checkAffordability(
  15000,    // item cost
  20000,    // monthly income
  8000,     // current savings
  12000     // monthly expenses
);

console.log(`Item Cost: ${formatCurrency(affordability.itemCost)}`);
console.log(`Monthly Income: ${formatCurrency(affordability.monthlyIncome)}`);
console.log(`Current Savings: ${formatCurrency(affordability.currentSavings)}`);
console.log(`Monthly Expenses: ${formatCurrency(affordability.monthlyExpenses)}`);
console.log(`\nAnalysis:`);
console.log(`  • ${affordability.percentOfIncome.toFixed(1)}% of monthly income`);
console.log(`  • ${affordability.percentOfSavings.toFixed(1)}% of current savings`);
console.log(`  • Impact on emergency fund: ${affordability.impactOnEmergencyFund ? "⚠️ Yes" : "✅ No"}`);
console.log(`\nRecommendation: ${affordability.recommendation.toUpperCase()}`);
console.log(`Reason: ${affordability.reason}`);

// Test 5: Challenging Scenario
console.log("\n\n📊 Test 5: Challenging Scenario");
console.log("Query: 'Save ₹200 per month - how much daily?'");
console.log("-".repeat(60));

const smallGoal = calculateSavingsGoal(
  200,      // target: save ₹200/month
  0,        // current savings
  1,        // in 1 month
  15000     // monthly income
);

console.log(`Target: ${formatCurrency(smallGoal.targetAmount)}`);
console.log(`Timeframe: ${smallGoal.timeframeMonths} month`);
console.log(`\nRequired Savings:`);
console.log(`  • Daily: ${formatCurrency(smallGoal.dailyRequired)}`);
console.log(`  • Weekly: ${formatCurrency(smallGoal.weeklyRequired)}`);
console.log(`  • Monthly: ${formatCurrency(smallGoal.monthlyRequired)}`);
console.log(`\n✅ Achievable: Only ${((smallGoal.monthlyRequired / 15000) * 100).toFixed(1)}% of income`);

console.log("\n" + "=".repeat(60));
console.log("✅ All calculations completed successfully!");
console.log("\nThese exact numbers are now available to Chatur for coaching.");
console.log("Chatur will explain what they mean for the user's situation.\n");
