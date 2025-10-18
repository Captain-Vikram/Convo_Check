import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

import { analystAgent } from "../agents/analyst.js";
import { getAgentConfig } from "../config.js";
import { loadTransactions } from "./transactions-loader.js";
import type { NormalizedTransaction } from "./transaction-normalizer.js";
import { runCoach } from "./coach-agent.js";

const OUTPUT_FILE_NAME = "habits.csv";

interface CategoryStat {
  category: string;
  count: number;
  totalSpend: number;
}

interface DirectionStat {
  direction: NormalizedTransaction["direction"];
  count: number;
  totalAmount: number;
}

interface WeekdayStat {
  weekday: string;
  count: number;
  expenseAmount: number;
}

interface TagStat {
  tag: string;
  count: number;
}

interface FlavorStat {
  flavor: NormalizedTransaction["flavor"];
  count: number;
}

interface CounterpartyStat {
  targetParty: string;
  count: number;
  expenseAmount: number;
}

interface SummaryTransaction {
  id: string;
  direction: NormalizedTransaction["direction"];
  amount: number;
  currency: string;
  category: string;
  flavor: NormalizedTransaction["flavor"];
  description: string;
  recordedAt: string;
  eventDate?: string;
  eventTime?: string;
  targetParty?: string;
  tags: string[];
  structuredSummary: string;
}

interface AnalysisStats {
  totalTransactions: number;
  totalExpense: number;
  totalIncome: number;
  averageTransactionAmount: number;
  expenseShare: number;
  categoryByCount: CategoryStat[];
  categoryBySpend: CategoryStat[];
  directionStats: DirectionStat[];
  weekdayStats: WeekdayStat[];
  tagStats: TagStat[];
  flavorStats: FlavorStat[];
  counterpartyStats: CounterpartyStat[];
  last30DayTransactions: number;
  last30DayExpenseTotal: number;
  last30DayIncomeTotal: number;
  savingsRate30d: number;
  currencyUsage: string[];
  largestTransactions: SummaryTransaction[];
  recentTransactions: SummaryTransaction[];
}

export interface HabitInsight {
  habitLabel: string;
  evidence: string;
  counsel: string;
  fullText: string;
}

export async function runAnalyst(): Promise<void> {
  const transactions = await loadTransactions();

  if (transactions.length === 0) {
    const placeholder: HabitInsight = {
      habitLabel: "Insufficient History",
      evidence: "0 logged transactions",
      counsel: "Log more activity to unlock insights.",
      fullText:
        "- Habit Label: Insufficient History; Evidence: 0 logged transactions; Counsel: Log more activity to unlock insights.",
    };
    await persistReport([placeholder]);
    console.warn(
      `[analyst] No transactions found. Wrote placeholder report to data/${OUTPUT_FILE_NAME}.`,
    );
    return;
  }

  const previousInsights = await loadExistingInsights();
  const stats = buildAnalysisStats(transactions);
  const prompt = buildAnalystPrompt(stats);
  const rawOutput = await callLanguageModel(prompt);
  const bulletLines = normalizeBulletLines(rawOutput);
  let insights: HabitInsight[];

  try {
    insights = bulletLines.map(parseHabitInsight);
  } catch (error) {
    console.error("[analyst] Failed to parse bullet lines", bulletLines);
    throw error;
  }
  await persistReport(insights);
  console.log(`[analyst] Updated habits narrative with ${insights.length} insights.`);

  try {
    await runCoach({ latestInsights: insights, previousInsights, trigger: "analyst" });
  } catch (error) {
    console.error("[analyst] Failed to hand off insights to Coach", error);
  }
}

function buildAnalysisStats(transactions: NormalizedTransaction[]): AnalysisStats {
  const categoryMap = new Map<string, { count: number; totalSpend: number }>();
  const directionMap = new Map<NormalizedTransaction["direction"], { count: number; totalAmount: number }>();
  const weekdayMap = new Map<string, { count: number; expenseAmount: number }>();
  const tagMap = new Map<string, number>();
  const flavorMap = new Map<NormalizedTransaction["flavor"], number>();
  const counterpartyMap = new Map<string, { count: number; expenseAmount: number }>();
  const currencySet = new Set<string>();

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime());
  thirtyDaysAgo.setDate(now.getDate() - 30);

  let totalExpense = 0;
  let totalIncome = 0;
  let last30DayTransactions = 0;
  let last30DayExpenseTotal = 0;
  let last30DayIncomeTotal = 0;

  for (const transaction of transactions) {
    currencySet.add(transaction.currency);

    const categoryKey = transaction.category || "Uncategorized";
    const categoryState = categoryMap.get(categoryKey) ?? { count: 0, totalSpend: 0 };
    categoryState.count += 1;
    if (transaction.direction === "expense") {
      categoryState.totalSpend += transaction.amount;
    }
    categoryMap.set(categoryKey, categoryState);

    const directionState = directionMap.get(transaction.direction) ?? { count: 0, totalAmount: 0 };
    directionState.count += 1;
    directionState.totalAmount += transaction.amount;
    directionMap.set(transaction.direction, directionState);

    flavorMap.set(transaction.flavor, (flavorMap.get(transaction.flavor) ?? 0) + 1);

    const eventMoment = resolveEventMoment(transaction) ?? toDate(transaction.recordedAt);
    const weekday = eventMoment
      ? eventMoment.toLocaleDateString("en-US", { weekday: "long" })
      : "Unknown";
    const weekdayState = weekdayMap.get(weekday) ?? { count: 0, expenseAmount: 0 };
    weekdayState.count += 1;
    if (transaction.direction === "expense") {
      weekdayState.expenseAmount += transaction.amount;
    }
    weekdayMap.set(weekday, weekdayState);

    if (eventMoment && eventMoment >= thirtyDaysAgo) {
      last30DayTransactions += 1;
      if (transaction.direction === "expense") {
        last30DayExpenseTotal += transaction.amount;
      } else if (transaction.direction === "income") {
        last30DayIncomeTotal += transaction.amount;
      }
    }

    if (transaction.direction === "expense") {
      totalExpense += transaction.amount;
    } else {
      totalIncome += transaction.amount;
    }

    for (const tag of transaction.tags) {
      tagMap.set(tag, (tagMap.get(tag) ?? 0) + 1);
    }

    if (transaction.meta.targetParty) {
      const key = transaction.meta.targetParty;
      const counterpartyState = counterpartyMap.get(key) ?? { count: 0, expenseAmount: 0 };
      counterpartyState.count += 1;
      if (transaction.direction === "expense") {
        counterpartyState.expenseAmount += transaction.amount;
      }
      counterpartyMap.set(key, counterpartyState);
    }
  }

  const averageTransactionAmount =
    transactions.length > 0 ? (totalExpense + totalIncome) / transactions.length : 0;
  const expenseShare =
    totalExpense + totalIncome > 0 ? totalExpense / (totalExpense + totalIncome) : 0;
  const savingsRate30d =
    last30DayIncomeTotal > 0
      ? (last30DayIncomeTotal - last30DayExpenseTotal) / last30DayIncomeTotal
      : 0;

  const categoryEntries = Array.from(categoryMap.entries()).map(([category, value]) => ({
    category,
    count: value.count,
    totalSpend: value.totalSpend,
  }));
  const categoryByCount = [...categoryEntries].sort((a, b) => b.count - a.count);
  const categoryBySpend = [...categoryEntries].sort((a, b) => b.totalSpend - a.totalSpend);

  const directionStats = Array.from(directionMap.entries()).map(([direction, value]) => ({
    direction,
    count: value.count,
    totalAmount: value.totalAmount,
  }));

  const weekdayStats = Array.from(weekdayMap.entries()).map(([weekday, value]) => ({
    weekday,
    count: value.count,
    expenseAmount: value.expenseAmount,
  }));
  weekdayStats.sort((a, b) => b.count - a.count);

  const tagStats = Array.from(tagMap.entries()).map(([tag, count]) => ({ tag, count }));
  tagStats.sort((a, b) => b.count - a.count);

  const flavorStats = Array.from(flavorMap.entries()).map(([flavor, count]) => ({
    flavor,
    count,
  }));
  flavorStats.sort((a, b) => b.count - a.count);

  const counterpartyStats = Array.from(counterpartyMap.entries()).map(([targetParty, value]) => ({
    targetParty,
    count: value.count,
    expenseAmount: value.expenseAmount,
  }));
  counterpartyStats.sort((a, b) => b.expenseAmount - a.expenseAmount);

  const currencyUsage = Array.from(currencySet).sort();

  const largestTransactions = pickLargestTransactions(transactions, 5);
  const recentTransactions = pickMostRecentTransactions(transactions, 5);

  return {
    totalTransactions: transactions.length,
    totalExpense,
    totalIncome,
    averageTransactionAmount,
    expenseShare,
    categoryByCount,
    categoryBySpend,
    directionStats,
    weekdayStats,
    tagStats,
    flavorStats,
    counterpartyStats,
    last30DayTransactions,
    last30DayExpenseTotal,
    last30DayIncomeTotal,
    savingsRate30d,
    currencyUsage,
    largestTransactions,
    recentTransactions,
  };
}

function buildAnalystPrompt(stats: AnalysisStats): string {
  const payload = buildPromptPayload(stats);
  const lines: string[] = [];
  lines.push("Apply the Insight Protocol to create bullet habit insights for this user.");
  lines.push(
    `Totals (lifetime): ${stats.totalTransactions} transactions | expense ${roundNumber(stats.totalExpense)} | income ${roundNumber(stats.totalIncome)} | avg ticket ${roundNumber(stats.averageTransactionAmount)}.`,
  );
  lines.push(
    `Last 30 days: ${stats.last30DayTransactions} tx | spend ${roundNumber(stats.last30DayExpenseTotal)} | income ${roundNumber(stats.last30DayIncomeTotal)} | savings rate ${roundNumber(stats.savingsRate30d)}.`,
  );
  lines.push("Ground every insight in the JSON metrics below. Do not invent figures.");
  lines.push(
    "Example format: - Dining Discipline | Evidence: Dining spend 42% of expenses | Recommendation: Set a weekly dining cap.",
  );
  lines.push("Metrics JSON:");
  lines.push(JSON.stringify(payload, null, 2));
  return lines.join("\n");
}

function buildPromptPayload(stats: AnalysisStats) {
  return {
    totals: {
      totalTransactions: stats.totalTransactions,
      totalExpense: roundNumber(stats.totalExpense),
      totalIncome: roundNumber(stats.totalIncome),
      averageTransactionAmount: roundNumber(stats.averageTransactionAmount),
      expenseShare: roundNumber(stats.expenseShare),
      currencyUsage: stats.currencyUsage,
    },
    last30d: {
      transactionCount: stats.last30DayTransactions,
      expenseTotal: roundNumber(stats.last30DayExpenseTotal),
      incomeTotal: roundNumber(stats.last30DayIncomeTotal),
      savingsRate: roundNumber(stats.savingsRate30d),
      netCashflow: roundNumber(stats.last30DayIncomeTotal - stats.last30DayExpenseTotal),
    },
    categories: {
      byCount: limitArray(stats.categoryByCount, 5).map((entry) => ({
        category: entry.category,
        count: entry.count,
        totalSpend: roundNumber(entry.totalSpend),
      })),
      bySpend: limitArray(stats.categoryBySpend, 5).map((entry) => ({
        category: entry.category,
        count: entry.count,
        totalSpend: roundNumber(entry.totalSpend),
      })),
    },
    directions: stats.directionStats.map((entry) => ({
      direction: entry.direction,
      count: entry.count,
      totalAmount: roundNumber(entry.totalAmount),
    })),
    weekdays: limitArray(stats.weekdayStats, 7).map((entry) => ({
      weekday: entry.weekday,
      count: entry.count,
      expenseAmount: roundNumber(entry.expenseAmount),
    })),
    tags: limitArray(stats.tagStats, 10),
    flavors: stats.flavorStats,
    counterparties: limitArray(stats.counterpartyStats, 5).map((entry) => ({
      targetParty: entry.targetParty,
      count: entry.count,
      expenseAmount: roundNumber(entry.expenseAmount),
    })),
    largestTransactions: stats.largestTransactions,
    recentTransactions: stats.recentTransactions,
  };
}

async function callLanguageModel(prompt: string): Promise<string> {
  const { apiKey, model } = getAgentConfig("agent3");
  const provider = createGoogleGenerativeAI({ apiKey });
  const languageModel = provider(model);

  const result = await generateText({
    model: languageModel,
    messages: [
      { role: "system", content: analystAgent.systemPrompt },
      { role: "user", content: prompt },
    ],
  });

  return (result.text ?? "").trim();
}

async function persistReport(insights: HabitInsight[]): Promise<void> {
  const dataDir = join(process.cwd(), "data");
  await mkdir(dataDir, { recursive: true });
  const header = "habit_label,evidence,counsel,full_text";
  const rows = insights.map(
    (insight) =>
      [
        escapeForCsv(insight.habitLabel),
        escapeForCsv(insight.evidence),
        escapeForCsv(insight.counsel),
        escapeForCsv(insight.fullText),
      ].join(","),
  );
  const output = [header, ...rows].join("\n");
  await writeFile(join(dataDir, OUTPUT_FILE_NAME), `${output}\n`, "utf8");
}

async function loadExistingInsights(): Promise<HabitInsight[]> {
  try {
    const content = await readFile(join(process.cwd(), "data", OUTPUT_FILE_NAME), "utf8");
  const lines = content.split(/\r?\n/).filter((line: string) => line.trim().length > 0);

    if (lines.length <= 1) {
      return [];
    }

    const records: HabitInsight[] = [];
    for (let index = 1; index < lines.length; index += 1) {
      const values = parseCsvLine(lines[index]!);
      if (values.length < 4) {
        continue;
      }

      records.push({
        habitLabel: values[0] ?? "",
        evidence: values[1] ?? "",
        counsel: values[2] ?? "",
        fullText: values[3] ?? "",
      });
    }

    return records;
  } catch {
    return [];
  }
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === '"') {
      if (insideQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === "," && !insideQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

function normalizeBulletLines(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error("Language model returned empty output");
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error("Language model output did not contain any content");
  }

  return lines.map((line) => {
    if (line.startsWith("- ")) {
      return line;
    }
    const stripped = line.replace(/^[-*]\s*/, "");
    return `- ${stripped}`;
  });
}

function parseHabitInsight(line: string): HabitInsight {
  const withoutBullet = line.replace(/^-\s*/, "").trim();

  const structured = parseStructuredFieldInsight(withoutBullet);
  if (structured) {
    return { ...structured, fullText: line };
  }

  const labeled = parseLabelCounselInsight(withoutBullet);
  if (labeled) {
    return { ...labeled, fullText: line };
  }

  const simple = parseSimpleCounselInsight(withoutBullet);
  if (simple) {
    return { ...simple, fullText: line };
  }

  throw new Error(
    "Language model output did not match the expected Habit Label/Evidence/Counsel structure.",
  );
}

function parseStructuredFieldInsight(content: string): Omit<HabitInsight, "fullText"> | null {
  const fieldRegex = /(Habit Label|Habit|Label|Evidence|Counsel|Recommendation)\s*[:\-]\s*/gi;
  const fields: Record<string, string> = {};

  let lastKey: string | null = null;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fieldRegex.exec(content)) !== null) {
    const captured = match[1];
    if (!captured) {
      continue;
    }

    if (lastKey) {
      const rawSegment = content.slice(lastIndex, match.index);
      fields[lastKey] = cleanseValue(rawSegment);
    }

    lastKey = normalizeKey(captured);
    lastIndex = fieldRegex.lastIndex;
  }

  if (lastKey) {
    const finalSegment = content.slice(lastIndex);
    fields[lastKey] = cleanseValue(finalSegment);
  }

  const habitLabel = fields["habit_label"] ?? fields["habit"] ?? fields["label"];
  const evidence = fields["evidence"];
  const counsel = fields["counsel"] ?? fields["recommendation"];

  if (!habitLabel || !evidence || !counsel) {
    return null;
  }

  return {
    habitLabel,
    evidence,
    counsel,
  };
}

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

function cleanseValue(raw: string): string {
  return raw.replace(/^[\s;,\.\-]+/, "").replace(/[\s;,\.\-]+$/, "").trim();
}

function parseLabelCounselInsight(content: string): Omit<HabitInsight, "fullText"> | null {
  const counselRegex = /(?:;|\.)\s*(Counsel|Advice)\s*[:\-]\s*(.+)$/i;
  const counselMatch = counselRegex.exec(content);

  if (!counselMatch) {
    return null;
  }

  const capturedCounsel = counselMatch[2];
  if (!capturedCounsel) {
    return null;
  }

  const counsel = cleanseValue(capturedCounsel);
  const beforeCounsel = content.slice(0, counselMatch.index).trim();
  const colonIndex = beforeCounsel.indexOf(":");

  if (colonIndex === -1) {
    return null;
  }

  let habitLabel = cleanseValue(beforeCounsel.slice(0, colonIndex));
  let evidence = cleanseValue(beforeCounsel.slice(colonIndex + 1));

  if (/^Evidence\s*[:\-]/i.test(evidence)) {
    evidence = cleanseValue(evidence.replace(/^Evidence\s*[:\-]\s*/i, ""));
  }

  if (/^Habit\s*Label\s*[:\-]/i.test(habitLabel)) {
    habitLabel = cleanseValue(habitLabel.replace(/^Habit\s*Label\s*[:\-]\s*/i, ""));
  }

  if (!habitLabel || !evidence || !counsel) {
    return null;
  }

  return {
    habitLabel,
    evidence,
    counsel,
  };
}

function parseSimpleCounselInsight(content: string): Omit<HabitInsight, "fullText"> | null {
  const counselPattern = /counsel\s*[:\-]\s*/i;
  const match = counselPattern.exec(content);
  if (!match) {
    return null;
  }

  const counselStart = match.index + match[0].length;
  const counsel = cleanseValue(content.slice(counselStart));
  const beforeCounsel = cleanseValue(content.slice(0, match.index));

  const firstSeparator = beforeCounsel.indexOf(":");
  if (firstSeparator === -1) {
    return null;
  }

  const habitLabel = cleanseValue(beforeCounsel.slice(0, firstSeparator));
  const evidence = cleanseValue(beforeCounsel.slice(firstSeparator + 1));

  if (!habitLabel || !evidence || !counsel) {
    return null;
  }

  return {
    habitLabel,
    evidence,
    counsel,
  };
}

function pickLargestTransactions(
  transactions: NormalizedTransaction[],
  limit: number,
): SummaryTransaction[] {
  return transactions
    .slice()
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit)
    .map(summarizeTransaction);
}

function pickMostRecentTransactions(
  transactions: NormalizedTransaction[],
  limit: number,
): SummaryTransaction[] {
  return transactions
    .slice()
    .sort((a, b) => {
      const left = resolveSortMoment(a);
      const right = resolveSortMoment(b);
      return right - left;
    })
    .slice(0, limit)
    .map(summarizeTransaction);
}

function summarizeTransaction(transaction: NormalizedTransaction): SummaryTransaction {
  const summary: SummaryTransaction = {
    id: transaction.id,
    direction: transaction.direction,
    amount: roundNumber(transaction.amount),
    currency: transaction.currency,
    category: transaction.category,
    flavor: transaction.flavor,
    description: transaction.description,
    recordedAt: transaction.recordedAt,
    tags: transaction.tags,
    structuredSummary: transaction.structuredSummary,
  };

  if (transaction.eventDate) {
    summary.eventDate = transaction.eventDate;
  }

  if (transaction.eventTime) {
    summary.eventTime = transaction.eventTime;
  }

  if (transaction.meta.targetParty) {
    summary.targetParty = transaction.meta.targetParty;
  }

  return summary;
}

function resolveSortMoment(transaction: NormalizedTransaction): number {
  const recorded = toDate(transaction.recordedAt);
  if (recorded) {
    return recorded.getTime();
  }
  const eventMoment = resolveEventMoment(transaction);
  if (eventMoment) {
    return eventMoment.getTime();
  }
  return 0;
}

function resolveEventMoment(transaction: NormalizedTransaction): Date | undefined {
  if (transaction.eventDate && transaction.eventTime) {
    const candidate = `${transaction.eventDate}T${transaction.eventTime}`;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }

  if (transaction.eventDate) {
    const parsed = Date.parse(transaction.eventDate);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }

  return undefined;
}

function toDate(value?: string): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return new Date(parsed);
}

function limitArray<T>(entries: T[], limit: number): T[] {
  return entries.slice(0, Math.max(limit, 0));
}

function roundNumber(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
}

function escapeForCsv(value: string): string {
  if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

runAnalyst().catch((error) => {
  console.error("[analyst] Failed to generate habits narrative", error);
  process.exitCode = 1;
});
