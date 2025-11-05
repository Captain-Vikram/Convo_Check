/**
 * Intent parser for detecting user commands when LLM tool-calling fails.
 * Provides fallback patterns for critical agent coordination.
 */

export interface ParsedIntent {
  logExpense?: { amount: number; description: string };
  logIncome?: { amount: number; description: string };
  querySummary?: boolean;
  queryRecent?: { count: number };
  requestCoach?: boolean;
  requestInsights?: boolean;
}

export function parseUserIntent(input: string): ParsedIntent {
  const normalized = input.toLowerCase().trim();
  const intent: ParsedIntent = {};

  // Expense logging patterns
  const expensePatterns = [
    /(?:spent|paid|expense|bought)\s+(?:inr|rs\.?|₹)?\s*(\d+(?:\.\d+)?)\s+(?:on|for)\s+(.+?)(?:\.|$)/i,
    /(\d+(?:\.\d+)?)\s+(?:inr|rs\.?|₹)\s+(?:spent|paid|expense|bought)\s+(?:on|for)\s+(.+?)(?:\.|$)/i,
  ];

  for (const pattern of expensePatterns) {
    const match = input.match(pattern);
    if (match) {
      intent.logExpense = {
        amount: parseFloat(match[1]!),
        description: match[2]!.trim(),
      };
      break;
    }
  }

  // Income logging patterns
  const incomePatterns = [
    /(?:received|earned|got|income)\s+(?:inr|rs\.?|₹)?\s*(\d+(?:\.\d+)?)\s+(?:from|for)\s+(.+?)(?:\.|$)/i,
    /(\d+(?:\.\d+)?)\s+(?:inr|rs\.?|₹)\s+(?:received|earned|got|income)\s+(?:from|for)\s+(.+?)(?:\.|$)/i,
  ];

  for (const pattern of incomePatterns) {
    const match = input.match(pattern);
    if (match) {
      intent.logIncome = {
        amount: parseFloat(match[1]!),
        description: match[2]!.trim(),
      };
      break;
    }
  }

  // Query patterns
  if (
    /(?:show|get|fetch|give me|what|display).*(?:transaction|spending|expense|history)/i.test(
      normalized,
    )
  ) {
    intent.querySummary = true;
  }

  const recentMatch = normalized.match(/(?:last|recent)\s+(\d+)\s+transaction/i);
  if (recentMatch) {
    intent.queryRecent = { count: parseInt(recentMatch[1]!, 10) };
  }

  // Coach/insights patterns
  if (
    /(?:financial|money|budget)\s+(?:tip|advice|guidance|help)/i.test(normalized) ||
    /(?:coach|chatur)/i.test(normalized)
  ) {
    intent.requestCoach = true;
  }

  if (/(?:habit|insight|pattern|analysis|analyze)/i.test(normalized)) {
    intent.requestInsights = true;
  }

  return intent;
}

export function hasIntent(intent: ParsedIntent): boolean {
  return (
    Boolean(intent.logExpense) ||
    Boolean(intent.logIncome) ||
    Boolean(intent.querySummary) ||
    Boolean(intent.queryRecent) ||
    Boolean(intent.requestCoach) ||
    Boolean(intent.requestInsights)
  );
}
