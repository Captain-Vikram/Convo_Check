import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";

import { generateText } from "ai";

import { getAgentConfig, createLanguageModel } from "../../config.js";
import { chatbotAgent, createChatbotToolset } from "../../agents/chatbot.js";
import { categorizeTransaction } from "../shared/categorize.js";
import type { LogCashTransactionPayload } from "../../tools/log-cash-transaction.js";
import type { CategorizationResult } from "../shared/categorize.js";
import {
  createDevAgentEnvironment,
  runDevPipeline,
  type DuplicateTransactionEvent,
} from "../dev/dev-agent.js";
import type { NormalizedTransaction } from "../dev/transaction-normalizer.js";
import { runCoach } from "../chatur/coach-agent.js";
import { handleCoachingQuery } from "../chatur/chatur-coordinator.js";
import { routeQuery } from "./query-router.js";
import { runAnalyst } from "../param/analyst-agent.js";
import { loadTransactions } from "../param/transactions-loader.js";
import { parseUserIntent, hasIntent, type ParsedIntent } from "./intent-parser.js";
import { searchWeb, formatSearchResults } from "../../tools/web-search.js";
import { handleNaturalQuery } from "./natural-query-handler.js";

const DEFAULT_MAX_HISTORY = 20;
const HABITS_FILE_PATH = join(process.cwd(), "data", "habits.csv");
const COACH_BRIEFINGS_PATH = join(process.cwd(), "data", "coach-briefings.json");

interface HabitRecord {
  habitLabel: string;
  evidence: string;
  counsel: string;
  fullText: string;
}

interface CoachBriefing {
  id: string;
  createdAt: string;
  headline: string;
  counsel: string;
}

let lastAnnouncedCoachBriefingId: string | undefined;
let autoAnnounceCoachTips = true; // Only announce automatically at startup

export interface ChatbotSessionOptions {
  maxHistory?: number;
}

type GenerateTextOptions = Parameters<typeof generateText>[0];
type ModelMessage = Extract<GenerateTextOptions, { messages: unknown[] }> extends {
  messages: Array<infer MessageType>;
}
  ? MessageType
  : never;

type ConversationHistory = ModelMessage[];

export async function runChatbotSession(options: ChatbotSessionOptions = {}): Promise<void> {
  const config = getAgentConfig("agent1");
  const languageModel = createLanguageModel(config);

  const loggedTransactions: Array<{
    entry: LogCashTransactionPayload;
    categorization: CategorizationResult;
    normalized: NormalizedTransaction;
  }> = [];
  const devEnvironment = await createDevAgentEnvironment();
  const devTools = devEnvironment.tools;
  const devAlerts: NormalizedTransaction[] = [];
  const duplicateAlerts: DuplicateTransactionEvent[] = [];
  const pendingDuplicateContext = new Map<
    string,
    { entry: LogCashTransactionPayload; categorization: CategorizationResult }
  >();
  let devAlertFlushing = false;
  let duplicateAlertFlushing = false;
  let devAlertsActive = true;
  let duplicateAlertsActive = true;
  let stopDevMonitor: (() => Promise<void>) | undefined;
  let stopDuplicateListener: (() => Promise<void>) | undefined;

  const tools = createChatbotToolset(
    async (payload: LogCashTransactionPayload) => {
      const categorization = categorizeTransaction(payload.description, payload.amount);
      const category =
        payload.category_suggestion.length > 0
          ? payload.category_suggestion
          : categorization.inferredCategory;

      const enrichedPayload: LogCashTransactionPayload = {
        ...payload,
        category_suggestion: category,
      };
      try {
        const result = await runDevPipeline(enrichedPayload, categorization, {
          tools: devTools,
        });

        if (result.status === "duplicate") {
          pendingDuplicateContext.set(result.pendingId, {
            entry: enrichedPayload,
            categorization,
          });
          renderDuplicatePending(
            enrichedPayload,
            categorization.flavor,
            result.pendingId,
            result.duplicateOf,
          );
          return;
        }

        if (result.status === "suppressed") {
          output.write(
            `[tool] 🔁 auto-ignore => Matched ${result.duplicateOf.id}, skipped duplicate within 2 minutes (${result.reason}).\n`,
          );
          return;
        }

        loggedTransactions.push({
          entry: enrichedPayload,
          categorization,
          normalized: result.normalized,
        });
        renderToolLog(enrichedPayload, categorization.flavor, result.normalized);
      } catch (error) {
        console.error("[dev-agent] failed to persist transaction", error);
        renderToolLog(enrichedPayload, categorization.flavor);
      }
    },
    async () => {
      try {
        // Request fresh analysis from Param
        await runAnalyst();
        
        // Load insights from Param
        const insights = await loadHabitRecords();
        
        // Get latest coach briefing
        const coachBriefing = await loadLatestCoachBriefing();
        
        // Get transaction data from Dev's CSV
        const transactions = await loadTransactions();
        const totalExpense = transactions
          .filter((t: NormalizedTransaction) => t.direction === "expense")
          .reduce((sum: number, t: NormalizedTransaction) => sum + t.amount, 0);
        const totalIncome = transactions
          .filter((t: NormalizedTransaction) => t.direction === "income")
          .reduce((sum: number, t: NormalizedTransaction) => sum + t.amount, 0);
        const netBalance = totalIncome - totalExpense;

        const categoryMap = new Map<string, { totalSpent: number; count: number }>();
        for (const tx of transactions) {
          if (tx.direction === "expense") {
            const existing = categoryMap.get(tx.category) ?? { totalSpent: 0, count: 0 };
            existing.totalSpent += tx.amount;
            existing.count += 1;
            categoryMap.set(tx.category, existing);
          }
        }

        const topCategories = Array.from(categoryMap.entries())
          .map(([category, stats]) => ({ category, ...stats }))
          .sort((a, b) => b.totalSpent - a.totalSpent)
          .slice(0, 5);

        const recentTransactions = transactions
          .slice()
          .sort((a: NormalizedTransaction, b: NormalizedTransaction) => {
            const aTime = Date.parse(a.recordedAt);
            const bTime = Date.parse(b.recordedAt);
            return bTime - aTime;
          })
          .slice(0, 10)
          .map((t: NormalizedTransaction) => ({
            id: t.id,
            direction: t.direction,
            amount: t.amount,
            description: t.description,
            category: t.category,
            eventDate: t.eventDate,
          }));

        return {
          totalExpense,
          totalIncome,
          netBalance,
          transactionCount: transactions.length,
          recentTransactions,
          topCategories,
          paramInsights: insights.map((i) => i.fullText),
          coachAdvice: coachBriefing
            ? `${coachBriefing.headline} — ${coachBriefing.counsel}`
            : null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[chatbot] query_spending_summary failed:", message);
        throw error;
      }
    },
    async (query: string, maxResults?: number) => {
      // Factual answer executor for get_factual_answer tool
      console.log(`[mill] 🔍 Getting factual answer for: "${query}"`);
      try {
        const result = await searchWeb(query, maxResults || 3);
        
        if (result.totalResults > 0) {
          console.log(`[mill] ✅ Found ${result.totalResults} factual answers`);
        } else {
          console.log(`[mill] ❌ No factual answer found for "${query}"`);
        }
        
        return result;
      } catch (error) {
        console.error(`[mill] ❌ Factual answer lookup failed:`, error);
        return {
          query,
          results: [],
          searchTime: "0ms",
          totalResults: 0,
        };
      }
    },
  );

  const rl = createInterface({ input, output, terminal: true });
  const history: ConversationHistory = [];
  const maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;

  async function handleParsedIntent(intent: ParsedIntent, rawInput: string): Promise<boolean> {
    const actions: string[] = [];

    try {
      // Handle expense logging
      if (intent.logExpense) {
        const { amount, description } = intent.logExpense;
        const categorization = categorizeTransaction(description, amount);
        const payload: LogCashTransactionPayload = {
          amount,
          description,
          category_suggestion: categorization.inferredCategory,
          direction: "expense",
          raw_text: rawInput,
        };

        const result = await runDevPipeline(payload, categorization, { tools: devTools });
        if (result.status === "logged") {
          actions.push(`✓ Logged expense: INR ${amount} on ${description}`);
        } else if (result.status === "suppressed") {
          actions.push(`🔁 Auto-ignored duplicate expense (INR ${amount})`);
        }
      }

      // Handle income logging
      if (intent.logIncome) {
        const { amount, description } = intent.logIncome;
        const categorization = categorizeTransaction(description, amount);
        const payload: LogCashTransactionPayload = {
          amount,
          description,
          category_suggestion: categorization.inferredCategory,
          direction: "income",
          raw_text: rawInput,
        };

        const result = await runDevPipeline(payload, categorization, { tools: devTools });
        if (result.status === "logged") {
          actions.push(`✓ Logged income: INR ${amount} from ${description}`);
        }
      }

      // Handle query summary
      if (intent.querySummary || intent.queryRecent) {
        await runAnalyst();
        const transactions = await loadTransactions();
        const insights = await loadHabitRecords();
        const coachBriefing = await loadLatestCoachBriefing();

        if (intent.queryRecent) {
          const count = intent.queryRecent.count;
          const recent = transactions
            .slice()
            .sort((a: NormalizedTransaction, b: NormalizedTransaction) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
            .slice(0, count);

          actions.push(`\n📊 Last ${count} transactions:`);
          recent.forEach((tx: NormalizedTransaction, idx: number) => {
            const dir = tx.direction === "income" ? "Income" : "Expense";
            actions.push(
              `  ${idx + 1}. ${tx.eventDate || tx.recordedAt.split("T")[0]} - ${dir}: INR ${tx.amount} (${tx.category}) - ${tx.description}`,
            );
          });
        } else {
          const totalExpense = transactions
            .filter((t: NormalizedTransaction) => t.direction === "expense")
            .reduce((sum: number, t: NormalizedTransaction) => sum + t.amount, 0);
          const totalIncome = transactions
            .filter((t: NormalizedTransaction) => t.direction === "income")
            .reduce((sum: number, t: NormalizedTransaction) => sum + t.amount, 0);
          actions.push(
            `\n💰 Summary: ${transactions.length} transactions | Expense: INR ${totalExpense.toFixed(2)} | Income: INR ${totalIncome.toFixed(2)} | Net: INR ${(totalIncome - totalExpense).toFixed(2)}`,
          );
        }

        if (insights.length > 0 && (intent.requestInsights || intent.querySummary)) {
          actions.push(`\n🔍 Param's latest insights:`);
          insights.slice(0, 3).forEach((insight) => {
            actions.push(`  • ${insight.fullText}`);
          });
        }

        if (coachBriefing && (intent.requestCoach || intent.querySummary)) {
          actions.push(
            `\n💡 Coach says: ${coachBriefing.headline} — ${coachBriefing.counsel}`,
          );
        }
      }

      // Handle standalone coach/insights requests
      if (intent.requestCoach && !intent.querySummary) {
        const briefing = await runCoach({ trigger: "manual", question: rawInput });
        if (briefing) {
          actions.push(`\n💡 Coach says: ${briefing.headline} — ${briefing.counsel}`);
        }
      }

      if (intent.requestInsights && !intent.querySummary) {
        const insights = await loadHabitRecords();
        if (insights.length > 0) {
          actions.push(`\n🔍 Param's latest insights:`);
          insights.forEach((insight) => {
            actions.push(`  • ${insight.fullText}`);
          });
        }
      }

      if (actions.length > 0) {
        output.write(`mill> ${actions.join("\n")}\n\n`);
        return true;
      }

      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.write(`mill> Oops, something went wrong coordinating agents: ${message}\n`);
      return true;
    }
  }

  async function flushDuplicateAlerts(): Promise<void> {
    if (duplicateAlertFlushing || duplicateAlerts.length === 0 || !duplicateAlertsActive) {
      return;
    }

    duplicateAlertFlushing = true;

    try {
      while (duplicateAlerts.length > 0 && duplicateAlertsActive) {
        const duplicateEvent = duplicateAlerts.shift();

        if (!duplicateEvent) {
          continue;
        }

        const conversationContext = trimHistory(history, maxHistory);
        const candidateSummary = summarizeTransaction(duplicateEvent.candidate);
        const existingSummary = summarizeTransaction(duplicateEvent.existing);
        const instructions = [
          "(Dev Agent) Potential duplicate transaction detected.",
          `Pending ID: ${duplicateEvent.pendingId}. ${candidateSummary}.`,
          `Existing entry (${duplicateEvent.existing.id}): ${existingSummary}.`,
          "Ask the user if this new transaction should be logged or ignored as a duplicate.",
          `If they want it logged, have them type 'log duplicate ${duplicateEvent.pendingId}'.`,
          `If it's a duplicate, have them type 'ignore duplicate ${duplicateEvent.pendingId}'.`,
        ];
        const alertMessage = createUserMessage(instructions.join(" "));

        try {
          const messages: ModelMessage[] = [
            createSystemMessage(chatbotAgent.systemPrompt),
            ...conversationContext,
            alertMessage,
          ];

          const result = await generateText({
            model: languageModel,
            messages,
          });

          const assistantReply = result.text ?? "";

          if (assistantReply.trim().length > 0) {
            output.write(`mill> ${assistantReply.trim()}\n`);
          }

          const assistantMessages = (result.response?.messages ?? []) as ModelMessage[];
          const updatedHistory = [...conversationContext, alertMessage, ...assistantMessages];
          writeHistory(history, updatedHistory, maxHistory);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          output.write(`mill> Dev flagged a duplicate but I couldn't confirm it: ${message}.\n`);
        }
      }
    } finally {
      duplicateAlertFlushing = false;
    }
  }

  async function flushDevAlerts(): Promise<void> {
    if (devAlertFlushing || devAlerts.length === 0 || !devAlertsActive) {
      return;
    }

    devAlertFlushing = true;

    try {
      while (devAlerts.length > 0 && devAlertsActive) {
        const alertRecord = devAlerts.shift();

        if (!alertRecord) {
          continue;
        }

        const conversationContext = trimHistory(history, maxHistory);
        const summarySegments = [
          "(Dev Agent) Detected a transaction added directly to the CSV outside Mill's tool flow.",
          `Transaction ID: ${alertRecord.id}.`,
          `${alertRecord.direction === "income" ? "Income" : "Expense"} ${alertRecord.currency} ${alertRecord.amount} on ${alertRecord.eventDate}${
            alertRecord.eventTime ? ` ${alertRecord.eventTime}` : ""
          }.`,
          alertRecord.description.length > 0
            ? `Description: ${alertRecord.description}.`
            : "No description captured.",
          "Ask the user whether this entry is expected or if corrections are needed.",
        ];
        const alertMessage = createUserMessage(summarySegments.join(" "));

        try {
          const messages: ModelMessage[] = [
            createSystemMessage(chatbotAgent.systemPrompt),
            ...conversationContext,
            alertMessage,
          ];

          const result = await generateText({
            model: languageModel,
            messages,
          });

          const assistantReply = result.text ?? "";

          if (assistantReply.trim().length > 0) {
            output.write(`mill> ${assistantReply.trim()}\n`);
          }

          const assistantMessages = (result.response?.messages ?? []) as ModelMessage[];
          const updatedHistory = [...conversationContext, alertMessage, ...assistantMessages];
          writeHistory(history, updatedHistory, maxHistory);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          output.write(`mill> Dev spotted a CSV update but I couldn't ask about it: ${message}.\n`);
        }
      }
    } finally {
      devAlertFlushing = false;
    }
  }

  function removeQueuedDuplicateAlerts(pendingId: string): void {
    for (let index = duplicateAlerts.length - 1; index >= 0; index -= 1) {
      const alert = duplicateAlerts[index];
      if (alert && alert.pendingId === pendingId) {
        duplicateAlerts.splice(index, 1);
      }
    }
  }

  async function resolveDuplicateCommand(
    pendingId: string,
    action: "record" | "ignore",
  ): Promise<void> {
    try {
      const resolution = await devEnvironment.resolveDuplicate(pendingId, action);

      if (resolution.status === "not-found") {
        output.write(
          `mill> I can't find a duplicate with id ${pendingId} anymore. Maybe it's already settled?\n`,
        );
        return;
      }

      removeQueuedDuplicateAlerts(pendingId);

      if (resolution.status === "recorded") {
        const context = pendingDuplicateContext.get(pendingId);

        if (context) {
          loggedTransactions.push({
            entry: context.entry,
            categorization: context.categorization,
            normalized: resolution.candidate,
          });
          renderToolLog(context.entry, context.categorization.flavor, resolution.candidate);
          pendingDuplicateContext.delete(pendingId);
        } else {
          renderDuplicateRecorded(resolution.candidate);
        }

        output.write(`mill> Logged it! Thanks for clearing that up. 🙌\n`);
        return;
      }

      if (resolution.status === "ignored") {
        pendingDuplicateContext.delete(pendingId);
        output.write(`mill> Cool, I'll ignore that lookalike. 👍\n`);
        return;
      }

      output.write(`mill> Duplicate ${pendingId} already looks wrapped up.\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.write(`mill> Yikes, couldn't resolve duplicate ${pendingId}: ${message}.\n`);
    }
  }

  async function handleDuplicateCommand(command: string): Promise<boolean> {
    const logMatch = command.match(/^log duplicate\s+([a-f0-9-]{6,})$/i);
    if (logMatch) {
      const rawId = logMatch[1]?.toLowerCase();
      if (rawId) {
        await resolveDuplicateCommand(rawId, "record");
        return true;
      }
    }

    const ignoreMatch = command.match(/^(?:ignore|dismiss)\s+duplicate\s+([a-f0-9-]{6,})$/i);
    if (ignoreMatch) {
      const rawId = ignoreMatch[1]?.toLowerCase();
      if (rawId) {
        await resolveDuplicateCommand(rawId, "ignore");
        return true;
      }
    }

    return false;
  }

  try {
    stopDevMonitor = await devEnvironment.startCsvMonitor(async (records: NormalizedTransaction[]) => {
      if (records.length === 0 || !devAlertsActive) {
        return;
      }

      devAlerts.push(...records);
      void flushDevAlerts();
    });
  } catch (error) {
    console.error("[dev-agent] CSV monitor unavailable", error);
  }

  try {
    stopDuplicateListener = await devEnvironment.onDuplicate(async (event: DuplicateTransactionEvent) => {
      if (!duplicateAlertsActive) {
        return;
      }

      duplicateAlerts.push(event);
      void flushDuplicateAlerts();
    });
  } catch (error) {
    console.error("[dev-agent] Duplicate monitor unavailable", error);
  }

  renderBanner();
  output.write("\n🚀 Initializing Multi-Agent System...\n");
  output.write("  ✓ Dev Agent - Monitoring transactions.csv for changes\n");
  output.write("  ✓ Dev Agent - Duplicate detection active\n");
  output.write("  ⏳ Param (Analyst) - Analyzing transaction patterns...\n");

  await refreshAnalystAndCoach();

  output.write("  ✓ Coach (Chatur) - Financial guidance ready\n");
  output.write("All agents operational! 🎯\n\n");

  // Announce initial coach tip ONCE before the main loop
  try {
    await announceLatestCoachBriefing();
  } catch (error) {
    // Silent fail - coach briefings may not be ready yet
  }

  try {
    while (true) {
      // NO automatic coach announcements in the loop - only on explicit user request
      await flushDuplicateAlerts();
      await flushDevAlerts();

      const rawInput = await rl.question("you> ");
      const normalizedInput = rawInput.trim();

      if (normalizedInput.length === 0) {
        continue;
      }

      if (shouldTerminate(normalizedInput)) {
        break;
      }

      if (await handleDuplicateCommand(normalizedInput)) {
        continue;
      }

      if (await handleInsightsCommand(normalizedInput)) {
        continue;
      }

      if (await handleCoachCommand(normalizedInput)) {
        continue;
      }

      if (await handleContextualCoachRequest(normalizedInput)) {
        continue;
      }

      // NEW: Smart Query Routing - Detect if Chatur should handle this
      try {
        const routing = await routeQuery(normalizedInput);
        
        if (routing.targetAgent === "chatur" && routing.confidence !== "low") {
          // Route to Chatur for coaching/calculations/advice
          output.write(`mill> Let me connect you with Coach Chatur for this... 🎯\n\n`);
          
          const coachingResult = await handleCoachingQuery(
            normalizedInput,
            "user123", // TODO: actual user ID
            routing,
            { enableFactualLookup: true }
          );
          
          output.write(`chatur> ${coachingResult.response}\n`);
          
          // Add to history as Chatur's response
          const userMessage = createUserMessage(normalizedInput);
          const chaturMessage = createAssistantMessage(coachingResult.response);
          const conversationContext = trimHistory(history, maxHistory);
          const updatedHistory = [...conversationContext, userMessage, chaturMessage];
          writeHistory(history, updatedHistory, maxHistory);
          
          continue;
        }
      } catch (error) {
        console.error("[routing] Failed to route query, falling back to Mill", error);
        // Fall through to Mill if routing fails
      }

      // Fallback intent parser for when LLM doesn't call tools
      const parsedIntent = parseUserIntent(normalizedInput);
      if (hasIntent(parsedIntent) && (await handleParsedIntent(parsedIntent, normalizedInput))) {
        continue;
      }

      const userMessage = createUserMessage(normalizedInput);
      const conversationContext = trimHistory(history, maxHistory);
      const messages: ModelMessage[] = [
        createSystemMessage(chatbotAgent.systemPrompt),
        ...conversationContext,
        userMessage,
      ];

      try {
        const result = await generateText({
          model: languageModel,
          messages,
          tools,
        });

        const assistantReply = result.text ?? "";

        if (assistantReply.trim().length > 0) {
          output.write(`mill> ${assistantReply.trim()}\n`);
        }

        const assistantMessages = (result.response?.messages ?? []) as ModelMessage[];
        const updatedHistory = [...conversationContext, userMessage, ...assistantMessages];
        writeHistory(history, updatedHistory, maxHistory);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
  output.write(`mill> Oops, my circuits fizzled: ${message}. Try again?\n`);
      }
    }
  } finally {
    devAlertsActive = false;
    duplicateAlertsActive = false;
    if (stopDevMonitor) {
      try {
        await stopDevMonitor();
      } catch (error) {
        console.error("[dev-agent] Failed to stop CSV monitor", error);
      }
    }

    if (stopDuplicateListener) {
      try {
        await stopDuplicateListener();
      } catch (error) {
        console.error("[dev-agent] Failed to stop duplicate monitor", error);
      }
    }

    rl.close();
  }

  if (loggedTransactions.length > 0) {
    output.write("\nSession summary: Logged transactions\n");
    loggedTransactions.forEach(({ normalized, categorization }, index) => {
      output.write(
        `  ${index + 1}. ${normalized.direction.toUpperCase()} ${normalized.currency} ${normalized.amount} - ${normalized.description} on ${normalized.eventDate}${normalized.eventTime ? ` ${normalized.eventTime}` : ""} [${normalized.category} / ${categorization.flavor}]\n`,
      );
    });
  }

  output.write("Goodbye!\n");
}

async function handleInsightsCommand(command: string): Promise<boolean> {
  const normalized = command.toLowerCase();
  if (!/^(show|get|view)?\s*insights$/.test(normalized) && normalized !== "how am i doing?" && normalized !== "how am i doing") {
    return false;
  }

  try {
    const records = await loadHabitRecords();
    if (records.length === 0) {
      output.write("mill> Param hasn't produced any insights yet. Try again after the next analyst run.\n");
    } else {
      output.write("mill> Here are the latest insight bullets from Param:\n");
      for (const record of records) {
        output.write(`  • ${record.fullText}\n`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.write(`mill> I couldn't read Param's insights: ${message}.\n`);
  }

  return true;
}

async function handleCoachCommand(command: string): Promise<boolean> {
  const normalized = command.toLowerCase();
  if (!/^(show|get|view)?\s*(coach|chatur)\s*(tip|advice)?$/.test(normalized)) {
    return false;
  }

  try {
    const briefing = await loadLatestCoachBriefing();
    if (!briefing) {
      output.write("mill> Coach Chatur hasn't posted a fresh note yet. Check back after the next analyst run.\n");
    } else {
      output.write(`mill> Coach says: ${briefing.headline} — ${briefing.counsel}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.write(`mill> I couldn't load Coach's guidance: ${message}.\n`);
  }

  return true;
}

const COACH_KEY_PHRASES = [
  "financial tip",
  "financial tips",
  "financial advice",
  "financial guidance",
  "financial roadmap",
  "budget plan",
  "plan my budget",
  "help me budget",
  "help me save",
  "help me plan",
  "money roadmap",
  "savings roadmap",
  "coach advice",
  "coach guidance",
  "chatur advice",
  "chatur guidance",
  "good purchase",
  "smart purchase",
  "wise purchase",
  "financial health",
  "achieve financial goal",
  "reach financial goal",
  "hit financial goal",
  "roadmap to my finances",
  "roadmap to finance",
  "roadmap to savings",
];

const COACH_KEYWORD_COMBINATIONS: Array<[string, string[]]> = [
  ["roadmap", ["finance", "financial", "money", "savings"]],
  ["is this", ["good purchase", "a good idea", "smart buy"]],
  ["make", ["financial plan", "financial strategy", "savings plan"]],
  ["give me", ["a budget plan", "money advice"]],
];

async function handleContextualCoachRequest(input: string): Promise<boolean> {
  if (!shouldTriggerCoach(input)) {
    return false;
  }

  try {
  const briefing = await runCoach({ trigger: "manual", question: input });
    if (!briefing) {
      output.write("mill> Coach is still gathering insights. Try again after Param's next analysis run.\n");
      return true;
    }

    output.write(`mill> Coach says: ${briefing.headline} — ${briefing.counsel}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.write(`mill> Coach couldn't weigh in right now: ${message}.\n`);
  }

  return true;
}

function shouldTriggerCoach(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }

  if (COACH_KEY_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return true;
  }

  for (const [anchor, keywords] of COACH_KEYWORD_COMBINATIONS) {
    if (!normalized.includes(anchor)) {
      continue;
    }

    if (keywords.some((keyword) => normalized.includes(keyword))) {
      return true;
    }
  }

  return false;
}

async function loadHabitRecords(): Promise<HabitRecord[]> {
  const content = await readFile(HABITS_FILE_PATH, "utf8");
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length <= 1) {
    return [];
  }

  const records: HabitRecord[] = [];
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
}

async function loadLatestCoachBriefing(): Promise<CoachBriefing | null> {
  const content = await readFile(COACH_BRIEFINGS_PATH, "utf8");
  const parsed = JSON.parse(content) as unknown;

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }

  const entries = parsed.filter((entry): entry is CoachBriefing => {
    return (
      entry &&
      typeof entry === "object" &&
      typeof (entry as CoachBriefing).id === "string" &&
      typeof (entry as CoachBriefing).headline === "string" &&
      typeof (entry as CoachBriefing).counsel === "string"
    );
  });

  if (entries.length === 0) {
    return null;
  }

  entries.sort((a, b) => {
    const left = Date.parse(a.createdAt ?? "");
    const right = Date.parse(b.createdAt ?? "");
    return right - left;
  });

  return entries[0] ?? null;
}

async function announceLatestCoachBriefing(): Promise<void> {
  try {
    // Only auto-announce once at startup, then disable
    if (!autoAnnounceCoachTips) {
      console.log("[DEBUG] Coach auto-announce disabled - skipping");
      return;
    }

    const latest = await loadLatestCoachBriefing();
    if (!latest) {
      console.log("[DEBUG] No coach briefing found");
      return;
    }

    if (latest.id === lastAnnouncedCoachBriefingId) {
      console.log("[DEBUG] Coach briefing already announced:", latest.id);
      return;
    }

    console.log("[DEBUG] Announcing coach tip:", latest.id);
    lastAnnouncedCoachBriefingId = latest.id;
    output.write(`mill> Daily Coach Tip — ${latest.headline}: ${latest.counsel}\n`);
    
    // Disable further automatic announcements
    autoAnnounceCoachTips = false;
    console.log("[DEBUG] Coach auto-announce now disabled");
  } catch (error) {
    // Stay quiet if the file isn't ready yet.
  }
}

async function refreshAnalystAndCoach(): Promise<void> {
  try {
    await runAnalyst();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.write(`  ✗ Param/Coach initialization failed: ${message}\n`);
  }
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      const next = line[index + 1];
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current);
  return result.map((entry) => entry.trim());
}

function createSystemMessage(content: string): ModelMessage {
  return { role: "system", content } as ModelMessage;
}

function createUserMessage(content: string): ModelMessage {
  return { role: "user", content } as ModelMessage;
}

function createAssistantMessage(content: string): ModelMessage {
  return { role: "assistant", content } as ModelMessage;
}

function trimHistory(history: ConversationHistory, maxHistory: number): ConversationHistory {
  if (history.length <= maxHistory) {
    return [...history];
  }

  return history.slice(history.length - maxHistory);
}

function writeHistory(
  target: ConversationHistory,
  updated: ConversationHistory,
  maxHistory: number,
): void {
  target.length = 0;
  const trimmed = trimHistory(updated, maxHistory);
  target.push(...trimmed);
}

function shouldTerminate(inputText: string): boolean {
  const lower = inputText.toLowerCase();
  return lower === "exit" || lower === "quit" || lower === "bye";
}

function renderBanner(): void {
  output.write("Mill is ready! Type 'exit' to leave the chat.\n");
}

function renderToolLog(
  payload: LogCashTransactionPayload,
  flavor: CategorizationResult["flavor"],
  normalized?: NormalizedTransaction,
): void {
  const badge = payload.direction === "income" ? "💰" : "💸";
  const vibe = flavor === "luxury" ? "🎉" : flavor === "treat" ? "😋" : "🛠️";
  const dateSnippet = normalized ? `, eventDate: ${normalized.eventDate}` : "";
  output.write(
    `[tool] ${badge}${vibe} log_cash_transaction => amount: ${payload.amount}, ` +
      `description: ${payload.description}, category: ${payload.category_suggestion}${dateSnippet}\n`,
  );
}

function renderDuplicatePending(
  payload: LogCashTransactionPayload,
  flavor: CategorizationResult["flavor"],
  pendingId: string,
  existing: NormalizedTransaction,
): void {
  const vibe = flavor === "luxury" ? "🎉" : flavor === "treat" ? "😋" : "🛠️";
  const directionLabel = payload.direction === "income" ? "income" : "expense";
  const existingSummary = summarizeTransaction(existing);
  output.write(
    `[tool] ⚠️${vibe} duplicate check => pending ${pendingId}: ${directionLabel} ${payload.amount} for ${payload.description}. ` +
      `Existing entry: ${existingSummary}. Use 'log duplicate ${pendingId}' to keep it or 'ignore duplicate ${pendingId}' to dismiss.\n`,
  );
}

function renderDuplicateRecorded(normalized: NormalizedTransaction): void {
  const directionLabel = normalized.direction === "income" ? "income" : "expense";
  const timeSnippet = normalized.eventTime ? ` ${normalized.eventTime}` : "";
  const descriptionSnippet = normalized.description.length > 0
    ? ` for ${normalized.description}`
    : "";
  output.write(
    `[tool] ✅ duplicate logged => ${directionLabel} ${normalized.currency} ${normalized.amount} on ${normalized.eventDate}${timeSnippet}${descriptionSnippet}.\n`,
  );
}

function summarizeTransaction(transaction: NormalizedTransaction): string {
  const directionLabel = transaction.direction === "income" ? "Income" : "Expense";
  const timeSnippet = transaction.eventTime ? ` ${transaction.eventTime}` : "";
  const descriptionSnippet = transaction.description.length > 0
    ? ` for ${transaction.description}`
    : "";
  return `${directionLabel} ${transaction.currency} ${transaction.amount} on ${transaction.eventDate}${timeSnippet}${descriptionSnippet}`;
}
