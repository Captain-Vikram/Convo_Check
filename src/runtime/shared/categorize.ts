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
  { matches: /(salary|pay|pocket\s*money|allowance|stipend)/i, category: "Income", flavor: "necessity" },
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
  const normalized = description.trim().toLowerCase();

  for (const rule of RULES) {
    if (rule.matches.test(normalized)) {
      if (rule.treatUpgradeThreshold && amount >= rule.treatUpgradeThreshold) {
        return {
          flavor: "luxury",
          inferredCategory: rule.treatUpgradeCategory ?? "Premium Treat",
        };
      }

      if (rule.luxuryThreshold && amount >= rule.luxuryThreshold) {
        return {
          flavor: "luxury",
          inferredCategory: rule.luxuryCategory ?? "Luxury Expense",
        };
      }

      return { flavor: rule.flavor, inferredCategory: rule.category };
    }
  }

  if (amount >= HIGH_VALUE_THRESHOLD) {
    return { flavor: "luxury", inferredCategory: "High-Value Expense" };
  }

  if (amount <= LOW_VALUE_THRESHOLD) {
    return { flavor: "necessity", inferredCategory: "Everyday Expense" };
  }

  return { flavor: "treat", inferredCategory: "General Expense" };
}
