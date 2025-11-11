import { categorizationCache } from "./categorization-cache.js";

export type SpendingFlavor = "necessity" | "treat" | "luxury";

export interface CategorizationResult {
  flavor: SpendingFlavor;
  inferredCategory: string;
}

type CategorizationRule = {
  matches: RegExp;
  category: string;
  flavor: SpendingFlavor;
  treatUpgradeThreshold?: number;
  treatUpgradeCategory?: string;
  luxuryThreshold?: number;
  luxuryCategory?: string;
};

const RULES: CategorizationRule[] = [
  // Income sources - all treated as necessity flavor
  { matches: /(salary|pay|pocket\s*money|allowance|stipend)/i, category: "Salary Income", flavor: "necessity" },
  { matches: /(side\s*project|side\s*hustle|freelance|freelancing|gig|contract|consulting)/i, category: "Side Hustle Income", flavor: "necessity" },
  { matches: /(gift|received\s+from|got\s+from|money\s+from\s+(father|mother|parent|friend|family))/i, category: "Gifts & Donations", flavor: "necessity" },
  { matches: /(refund|reimbursement|cashback|return)/i, category: "Refunds & Reimbursements", flavor: "necessity" },
  { matches: /(interest|dividend|investment\s+return|profit|earning)/i, category: "Interest & Dividends", flavor: "necessity" },
  { matches: /(part\s*time|part-time|extra\s+income|additional\s+income)/i, category: "Side Hustle Income", flavor: "necessity" },
  
  // Expenses
  { matches: /(rent|utilities|electricity|water|internet|gas)/i, category: "Essentials", flavor: "necessity" },
  { matches: /(grocery|groceries|vegetable|vegetables|fruit|milk|bread|supermarket)/i, category: "Food & Groceries", flavor: "necessity" },
  {
    matches: /(coffee|latte|tea|snack|breakfast|lunch|dinner|pizza|burger|sandwich|restaurant)/i,
    category: "Food & Dining",
    flavor: "treat",
    treatUpgradeThreshold: 300,
    treatUpgradeCategory: "Celebration Food",
  },
  { matches: /(party|celebration|concert|festival|vacation|travel|flight|hotel|resort)/i, category: "Experiences", flavor: "luxury" },
  {
    matches: /(shopping|clothes|fashion|apparel|shoes|makeup|accessory)/i,
    category: "Shopping",
    flavor: "treat",
    luxuryThreshold: 1500,
    luxuryCategory: "Premium Shopping",
  },
  { matches: /(electronics|gadget|console|smartphone|laptop|camera)/i, category: "Electronics", flavor: "luxury" },
  { matches: /(gift|present|donation|charity)/i, category: "Gifts & Giving", flavor: "treat" },
];

const HIGH_VALUE_THRESHOLD = 2000;
const LOW_VALUE_THRESHOLD = 100;

export function categorizeTransaction(description: string, amount: number): CategorizationResult {
  // Check cache first
  const cached = categorizationCache.get(description, amount);
  if (cached) {
    return cached;
  }

  const normalized = description.trim().toLowerCase();

  for (const rule of RULES) {
    if (rule.matches.test(normalized)) {
      if (rule.treatUpgradeThreshold && amount >= rule.treatUpgradeThreshold) {
        const result = {
          flavor: "luxury" as const,
          inferredCategory: rule.treatUpgradeCategory ?? "Premium Treat",
        };
        categorizationCache.set(description, amount, result);
        return result;
      }

      if (rule.luxuryThreshold && amount >= rule.luxuryThreshold) {
        const result = {
          flavor: "luxury" as const,
          inferredCategory: rule.luxuryCategory ?? "Luxury Expense",
        };
        categorizationCache.set(description, amount, result);
        return result;
      }

      const result = { flavor: rule.flavor, inferredCategory: rule.category };
      categorizationCache.set(description, amount, result);
      return result;
    }
  }

  let result: CategorizationResult;
  if (amount >= HIGH_VALUE_THRESHOLD) {
    result = { flavor: "luxury", inferredCategory: "High-Value Expense" };
  } else if (amount <= LOW_VALUE_THRESHOLD) {
    result = { flavor: "necessity", inferredCategory: "Everyday Expense" };
  } else {
    result = { flavor: "treat", inferredCategory: "General Expense" };
  }

  categorizationCache.set(description, amount, result);
  return result;
}
