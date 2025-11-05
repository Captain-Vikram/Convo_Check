/**
 * Expense Analysis Tool
 * 
 * Provides detailed expense breakdowns by category, vendor detection,
 * income source analysis, and spending patterns for smart coaching advice.
 */

import type { Transaction } from "../runtime/param/habit-tracker.js";

export interface CategoryBreakdown {
  category: string;
  total: number;
  percentage: number;
  transactionCount: number;
  vendors: VendorSpend[];
  averagePerTransaction: number;
}

export interface VendorSpend {
  vendor: string;
  amount: number;
  count: number;
}

export interface IncomeSource {
  source: string;
  total: number;
  transactionCount: number;
  averageAmount: number;
}

export interface ExpenseAnalysis {
  totalExpenses: number;
  totalIncome: number;
  netSavings: number;
  monthlyExpenses: number;
  monthlyIncome: number;
  categoryBreakdowns: CategoryBreakdown[];
  incomeSources: IncomeSource[];
  topVendors: VendorSpend[];
  savingsRate: number;
  highSpendCategories: string[]; // Categories >30% of expenses
}

export interface SpendingPattern {
  category: string;
  trend: "increasing" | "decreasing" | "stable";
  weeklyAverage: number;
  monthlyAverage: number;
  lastWeekSpend: number;
}

/**
 * Analyze expenses from transactions
 */
export function analyzeExpenses(transactions: Transaction[]): ExpenseAnalysis {
  if (!transactions || transactions.length === 0) {
    return {
      totalExpenses: 0,
      totalIncome: 0,
      netSavings: 0,
      monthlyExpenses: 0,
      monthlyIncome: 0,
      categoryBreakdowns: [],
      incomeSources: [],
      topVendors: [],
      savingsRate: 0,
      highSpendCategories: [],
    };
  }

  // Separate income and expenses
  const expenses = transactions.filter((t) => t.type === "expense" || t.amount < 0);
  const income = transactions.filter((t) => t.type === "income" || t.amount > 0);

  const totalExpenses = expenses.reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const totalIncome = income.reduce((sum, t) => sum + t.amount, 0);
  const netSavings = totalIncome - totalExpenses;

  // Calculate monthly averages (assuming data spans multiple months)
  const dates = transactions.map((t) => new Date(t.date));
  const minDate = new Date(Math.min(...dates.map((d) => d.getTime())));
  const maxDate = new Date(Math.max(...dates.map((d) => d.getTime())));
  const monthsSpan = Math.max(
    1,
    (maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24 * 30)
  );

  const monthlyExpenses = totalExpenses / monthsSpan;
  const monthlyIncome = totalIncome / monthsSpan;
  const savingsRate = totalIncome > 0 ? (netSavings / totalIncome) * 100 : 0;

  // Category breakdowns
  const categoryMap = new Map<string, { total: number; count: number; vendors: Map<string, { amount: number; count: number }> }>();

  for (const txn of expenses) {
    const category = txn.category || "Uncategorized";
    const vendor = extractVendor(txn.description);

    if (!categoryMap.has(category)) {
      categoryMap.set(category, { total: 0, count: 0, vendors: new Map() });
    }

    const catData = categoryMap.get(category)!;
    catData.total += Math.abs(txn.amount);
    catData.count += 1;

    if (!catData.vendors.has(vendor)) {
      catData.vendors.set(vendor, { amount: 0, count: 0 });
    }
    const vendorData = catData.vendors.get(vendor)!;
    vendorData.amount += Math.abs(txn.amount);
    vendorData.count += 1;
  }

  const categoryBreakdowns: CategoryBreakdown[] = Array.from(categoryMap.entries())
    .map(([category, data]) => ({
      category,
      total: data.total,
      percentage: totalExpenses > 0 ? (data.total / totalExpenses) * 100 : 0,
      transactionCount: data.count,
      vendors: Array.from(data.vendors.entries())
        .map(([vendor, vData]) => ({
          vendor,
          amount: vData.amount,
          count: vData.count,
        }))
        .sort((a, b) => b.amount - a.amount),
      averagePerTransaction: data.total / data.count,
    }))
    .sort((a, b) => b.total - a.total);

  // Income sources
  const incomeMap = new Map<string, { total: number; count: number }>();

  for (const txn of income) {
    const source = txn.category || extractIncomeSource(txn.description);

    if (!incomeMap.has(source)) {
      incomeMap.set(source, { total: 0, count: 0 });
    }

    const srcData = incomeMap.get(source)!;
    srcData.total += txn.amount;
    srcData.count += 1;
  }

  const incomeSources: IncomeSource[] = Array.from(incomeMap.entries())
    .map(([source, data]) => ({
      source,
      total: data.total,
      transactionCount: data.count,
      averageAmount: data.total / data.count,
    }))
    .sort((a, b) => b.total - a.total);

  // Top vendors across all categories
  const allVendors = new Map<string, { amount: number; count: number }>();
  for (const cat of categoryBreakdowns) {
    for (const vendor of cat.vendors) {
      if (!allVendors.has(vendor.vendor)) {
        allVendors.set(vendor.vendor, { amount: 0, count: 0 });
      }
      const vData = allVendors.get(vendor.vendor)!;
      vData.amount += vendor.amount;
      vData.count += vendor.count;
    }
  }

  const topVendors: VendorSpend[] = Array.from(allVendors.entries())
    .map(([vendor, data]) => ({
      vendor,
      amount: data.amount,
      count: data.count,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  // High spend categories (>30% of total expenses)
  const highSpendCategories = categoryBreakdowns
    .filter((cat) => cat.percentage > 30)
    .map((cat) => cat.category);

  return {
    totalExpenses,
    totalIncome,
    netSavings,
    monthlyExpenses,
    monthlyIncome,
    categoryBreakdowns,
    incomeSources,
    topVendors,
    savingsRate,
    highSpendCategories,
  };
}

/**
 * Extract vendor name from transaction description
 * Detects common vendors like Domino's, Uber, Ola, Swiggy, etc.
 */
function extractVendor(description: string): string {
  const desc = description.toLowerCase();

  // Food delivery
  if (desc.includes("domino")) return "Domino's";
  if (desc.includes("swiggy")) return "Swiggy";
  if (desc.includes("zomato")) return "Zomato";
  if (desc.includes("mcdonald")) return "McDonald's";
  if (desc.includes("kfc")) return "KFC";
  if (desc.includes("pizza")) return "Pizza";
  if (desc.includes("burger")) return "Burger";

  // Transportation
  if (desc.includes("uber")) return "Uber";
  if (desc.includes("ola")) return "Ola";
  if (desc.includes("rapido")) return "Rapido";
  if (desc.includes("cab") || desc.includes("taxi")) return "Cab";
  if (desc.includes("bus") || desc.includes("metro")) return "Public Transport";
  if (desc.includes("petrol") || desc.includes("fuel")) return "Fuel";

  // Shopping
  if (desc.includes("amazon")) return "Amazon";
  if (desc.includes("flipkart")) return "Flipkart";
  if (desc.includes("myntra")) return "Myntra";

  // Utilities
  if (desc.includes("electricity") || desc.includes("electric")) return "Electricity";
  if (desc.includes("water")) return "Water";
  if (desc.includes("internet") || desc.includes("broadband")) return "Internet";
  if (desc.includes("mobile") || desc.includes("recharge")) return "Mobile Recharge";

  // Entertainment
  if (desc.includes("netflix")) return "Netflix";
  if (desc.includes("prime") || desc.includes("amazon video")) return "Prime Video";
  if (desc.includes("hotstar")) return "Hotstar";
  if (desc.includes("movie") || desc.includes("cinema")) return "Movies";

  // Groceries
  if (desc.includes("grofer") || desc.includes("blinkit")) return "Groceries";
  if (desc.includes("dmart")) return "DMart";
  if (desc.includes("bigbasket")) return "BigBasket";

  // Generic
  return "Other";
}

/**
 * Extract income source from description
 */
function extractIncomeSource(description: string): string {
  const desc = description.toLowerCase();

  if (desc.includes("salary")) return "Salary";
  if (desc.includes("freelance") || desc.includes("gig")) return "Freelance/Gig";
  if (desc.includes("uber") || desc.includes("ola") || desc.includes("rapido")) return "Ride-sharing";
  if (desc.includes("zomato") || desc.includes("swiggy")) return "Food Delivery";
  if (desc.includes("interest")) return "Interest";
  if (desc.includes("refund")) return "Refund";
  if (desc.includes("bonus")) return "Bonus";

  return "Other Income";
}

/**
 * Analyze spending patterns over time
 */
export function analyzeSpendingPatterns(transactions: Transaction[]): SpendingPattern[] {
  if (!transactions || transactions.length === 0) {
    return [];
  }

  const expenses = transactions.filter((t) => t.type === "expense" || t.amount < 0);
  const categoryMap = new Map<string, Transaction[]>();

  for (const txn of expenses) {
    const category = txn.category || "Uncategorized";
    if (!categoryMap.has(category)) {
      categoryMap.set(category, []);
    }
    categoryMap.get(category)!.push(txn);
  }

  const patterns: SpendingPattern[] = [];
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  for (const [category, txns] of categoryMap.entries()) {
    const sortedTxns = txns.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Calculate weekly and monthly averages
    const lastWeekTxns = txns.filter((t) => new Date(t.date) >= oneWeekAgo);
    const lastMonthTxns = txns.filter((t) => new Date(t.date) >= oneMonthAgo);

    const lastWeekSpend = lastWeekTxns.reduce((sum, t) => sum + Math.abs(t.amount), 0);
    const lastMonthSpend = lastMonthTxns.reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const weeklyAverage = lastMonthSpend / 4;
    const monthlyAverage = lastMonthSpend;

    // Determine trend (simple: compare last week to 4-week average)
    let trend: "increasing" | "decreasing" | "stable" = "stable";
    if (lastWeekSpend > weeklyAverage * 1.2) {
      trend = "increasing";
    } else if (lastWeekSpend < weeklyAverage * 0.8) {
      trend = "decreasing";
    }

    patterns.push({
      category,
      trend,
      weeklyAverage,
      monthlyAverage,
      lastWeekSpend,
    });
  }

  return patterns.sort((a, b) => b.monthlyAverage - a.monthlyAverage);
}

/**
 * Get specific vendor spend for targeted advice
 */
export function getVendorSpend(transactions: Transaction[], vendorKeyword: string): VendorSpend | null {
  const expenses = transactions.filter((t) => t.type === "expense" || t.amount < 0);
  const vendorTxns = expenses.filter((t) => 
    t.description.toLowerCase().includes(vendorKeyword.toLowerCase())
  );

  if (vendorTxns.length === 0) {
    return null;
  }

  const total = vendorTxns.reduce((sum, t) => sum + Math.abs(t.amount), 0);

  return {
    vendor: vendorKeyword,
    amount: total,
    count: vendorTxns.length,
  };
}

/**
 * Format currency for Indian Rupees
 */
export function formatCurrency(amount: number): string {
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

/**
 * Format percentage
 */
export function formatPercentage(value: number): string {
  return `${value.toFixed(1)}%`;
}
