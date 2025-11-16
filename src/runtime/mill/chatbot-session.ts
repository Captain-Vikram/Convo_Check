import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { callLLM, createLLMClient } from "../shared/llm-client.js";
import { SeraAgent } from "../sera/sera-agent.js";
import type { CoreMessage } from "ai";

import { chatbotAgent, createChatbotToolset } from "../../agents/chatbot.js";
import { categorizeTransaction } from "../shared/categorize.js";
import type { LogCashTransactionPayload } from "../../tools/log-cash-transaction.js";
import type { CategorizationResult } from "../shared/categorize.js";
import {
  createDevAgentEnvironment,
  runDevPipeline,
  type DuplicateTransactionEvent,
} from "../dev/dev-agent.js";
import type { AlertRecord } from "../dev/alert-manager.js";
import type { BehaviorMatch } from "../dev/behavior-profile.js";
import type { NormalizedTransaction } from "../dev/transaction-normalizer.js";
import { runCoach } from "../chatur/coach-agent.js";
import { handleCoachingQuery } from "../chatur/chatur-coordinator.js";
import { routeQuery } from "./query-router.js";
import { runAnalyst } from "../param/analyst-agent.js";
import { loadTransactions } from "../param/transactions-loader.js";
import { parseUserIntent, hasIntent, type ParsedIntent } from "./intent-parser.js";
import { searchWeb, formatSearchResults } from "../../tools/web-search.js";
import { handleNaturalQuery } from "./natural-query-handler.js";
import { fetchHabitsFromApi, fetchCoachBriefingsFromApi } from "../dev/api-sync.js";
import {
  callGroundedSearchProvider,
  formatGroundedSearchResults,
} from "../../tools/grounded-search.js";
import type { GroundedSearchInput } from "../../tools/grounded-search.js";

const DEFAULT_MAX_HISTORY = 20;

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
  evidence: string;
  insightHash: string;
  trigger: "analyst" | "manual";
}

let lastAnnouncedCoachBriefingId: string | undefined;
let autoAnnounceCoachTips = true; // Only announce automatically at startup

export interface ChatbotSessionOptions {
  maxHistory?: number;
}

type ModelMessage = CoreMessage;

type ConversationHistory = ModelMessage[];

export async function runChatbotSession(options: ChatbotSessionOptions = {}): Promise<void> {
  const languageModel = createLLMClient("agent1");

  const loggedTransactions: Array<{
    entry: LogCashTransactionPayload;
    categorization: CategorizationResult;
    normalized: NormalizedTransaction;
  }> = [];
  const devEnvironment = await createDevAgentEnvironment();
  const devTools = devEnvironment.tools;
  const devAlerts: NormalizedTransaction[] = [];
  const anomalyAlerts: AlertRecord[] = [];
  const duplicateAlerts: DuplicateTransactionEvent[] = [];
  const pendingDuplicateContext = new Map<
    string,
    { entry: LogCashTransactionPayload; categorization: CategorizationResult }
  >();
  let devAlertFlushing = false;
  let anomalyAlertFlushing = false;
  let duplicateAlertFlushing = false;
  let devAlertsActive = true;
  let anomalyAlertsActive = true;
  let duplicateAlertsActive = true;
  let stopDuplicateListener: (() => Promise<void>) | undefined;
  let stopAnomalyListener: (() => void) | undefined;
  let paramRefreshPending = false;
  let paramRefreshInFlight = false;
  let lastParamRefreshReason = "startup";
  const pendingToolResponses: string[] = [];
  const seraAgent = new SeraAgent();
  let seraSessionId: string | undefined;

  function queueParamRefresh(reason: string): void {
    paramRefreshPending = true;
    lastParamRefreshReason = reason;
    void runQueuedParamRefresh();
  }

  async function runQueuedParamRefresh(): Promise<void> {
    if (paramRefreshInFlight || !paramRefreshPending) {
      return;
    }

    paramRefreshInFlight = true;
    paramRefreshPending = false;
    const reason = lastParamRefreshReason;

    try {
      console.log(`[mill] Refreshing Param insights (reason: ${reason})`);
      await runAnalyst();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[mill] Param analysis refresh failed (${reason}): ${message}`);
    } finally {
      paramRefreshInFlight = false;

      if (paramRefreshPending) {
        void runQueuedParamRefresh();
      }
    }
  }

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
          alertManager: devEnvironment.alertManager,
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
        pendingToolResponses.push(
          formatLogAck(enrichedPayload, result.normalized ?? null, categorization.flavor),
        );
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
  async (payload: GroundedSearchInput) => {
      console.log(
        `[mill] 📘 Grounded search requested: "${payload.query}" (intent=${payload.intent ?? "auto"})`,
      );
      const result = await callGroundedSearchProvider(payload).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[mill] Grounded search failed:", message);
        return {
          query: payload.query,
          sanitizedQuery: payload.query,
          provider: process.env.GROUNDED_SEARCH_PROVIDER ?? "external",
          latencyMs: 0,
          snippets: [],
          error: message,
        };
      });

      if (result.snippets.length === 0) {
        console.warn(`[mill] Grounded search returned no snippets for "${payload.query}"`);
      }

      pendingToolResponses.push(formatGroundedSearchResults(result));
      return result;
    },
  );

  const rl = createInterface({ 
    input, 
    output, 
    terminal: false,  // Disable terminal mode to fix PowerShell double-input issue
    prompt: ''
  });
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

        const result = await runDevPipeline(payload, categorization, {
          tools: devTools,
          alertManager: devEnvironment.alertManager,
        });
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

        const result = await runDevPipeline(payload, categorization, {
          tools: devTools,
          alertManager: devEnvironment.alertManager,
        });
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

  async function handleSeraConversation(rawInput: string, normalizedInput: string): Promise<boolean> {
    const trimmed = normalizedInput.trim();
    const hasSeraSession = Boolean(seraSessionId);

    if (hasSeraSession && shouldExitSera(trimmed)) {
      const sessionId = seraSessionId!;
      seraAgent.endConversation(sessionId, "user-request");
      seraSessionId = undefined;
      output.write("mill> All right, back to money mode whenever you need me. 💼\n");
      return true;
    }

    const wantsSera = shouldTriggerSera(trimmed);

    if (!hasSeraSession && !wantsSera) {
      return false;
    }

    try {
      if (!hasSeraSession) {
        const session = seraAgent.startConversation({ suppressGreeting: true });
        seraSessionId = session.sessionId;
      }

      const sessionId = seraSessionId!;
      const result = await seraAgent.continueConversation(sessionId, rawInput);

      if (result.message.trim().length > 0) {
        output.write(`sera> ${result.message.trim()}\n`);
      }

      if (result.completed) {
        seraAgent.endConversation(sessionId, "completed");
        seraSessionId = undefined;
        output.write("mill> Hope that helped! I'm standing by for your next finance move. 💰\n");
      }

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.write(`mill> Sera hit a snag: ${message}. I'll take it from here.\n`);
      if (seraSessionId) {
        seraAgent.endConversation(seraSessionId, "error");
        seraSessionId = undefined;
      }
      return false;
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

          const result = await callLLM("agent1", {
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
        const transaction = devAlerts.shift();

        if (!transaction) {
          continue;
        }
        const assistantText = buildDevNotification(transaction);

        if (assistantText.trim().length === 0) {
          continue;
        }

        output.write(`mill> ${assistantText}\n`);
        const updatedHistory = [...history, createAssistantMessage(assistantText)];
        writeHistory(history, updatedHistory, maxHistory);
      }
    } finally {
      devAlertFlushing = false;
    }
  }

  async function flushAnomalyAlerts(): Promise<void> {
    if (anomalyAlertFlushing || anomalyAlerts.length === 0 || !anomalyAlertsActive) {
      return;
    }

    anomalyAlertFlushing = true;

    try {
      while (anomalyAlerts.length > 0 && anomalyAlertsActive) {
        const alertRecord = anomalyAlerts.shift();

        if (!alertRecord) {
          continue;
        }

        if (alertRecord.severity === "low") {
          continue;
        }

        if (alertRecord.severity === "medium" && alertRecord.confidence < 0.75) {
          continue;
        }

        const conversationContext = trimHistory(history, maxHistory);
        const transactionSummary = describeAlertTransaction(alertRecord);
        const behaviorNarrative = summarizeBehaviorContext(alertRecord);
        const behaviorSummary = behaviorNarrative?.summary;
        const behaviorClassification = behaviorNarrative?.classification ?? "unknown";
        const severityLabel = alertRecord.severity.toUpperCase();
        const confidencePercent = Math.round(
          Math.min(1, Math.max(0, alertRecord.confidence)) * 100,
        );
        const severityIcon = getSeverityIcon(alertRecord.severity);
        const ruleLabel = formatAlertRule(alertRecord.rule);
        const guidanceLine = composeAlertGuidance(alertRecord.severity, behaviorClassification);
        const lines = [
          `${severityIcon} ${alertRecord.severity === "high" ? "Priority alert" : "Heads-up"} — ${ruleLabel} (confidence ${confidencePercent}%)`,
          `Summary: ${alertRecord.summary}`,
          transactionSummary ? `Transaction: ${transactionSummary}` : undefined,
          behaviorSummary ? `Context: ${behaviorSummary}` : undefined,
          guidanceLine,
        ].filter((line): line is string => Boolean(line && line.trim().length > 0));

        if (lines.length === 0) {
          continue;
        }

        const messageText = lines.join("\n");
        output.write(`mill> ${messageText}\n`);
        const updatedHistory = [...conversationContext, createAssistantMessage(messageText)];
        writeHistory(history, updatedHistory, maxHistory);
      }
    } finally {
      anomalyAlertFlushing = false;
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
    stopAnomalyListener = devEnvironment.alertManager.subscribe((records) => {
      if (!anomalyAlertsActive || records.length === 0) {
        return;
      }

      anomalyAlerts.push(...records);
      void flushAnomalyAlerts();
    });
  } catch (error) {
    console.error("[dev-agent] Alert listener unavailable", error);
  }

  // CSV monitor removed - transactions now come from database API
  // Param refresh is triggered by the analyst agent after transaction processing

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
  output.write("  ✓ Dev Agent - Monitoring transactions for changes\n");
  output.write("  ✓ Dev Agent - Duplicate detection active\n");
  output.write("  ⏸ Param (Analyst) - Idle until new transactions arrive\n");
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
      await flushAnomalyAlerts();
      await flushDevAlerts();

      output.write("you> ");  // Manual prompt since terminal=false
      const rawInput = await rl.question("");
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

      if (await handleSeraConversation(rawInput, normalizedInput)) {
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

          if (coachingResult.agentRecommendations?.length) {
            coachingResult.agentRecommendations.forEach((recommendation) => {
              const sourceLabel = recommendation.agent === "mill" ? "mill" : "system";
              const cadenceNote = recommendation.cadence ? ` (cadence: ${recommendation.cadence})` : "";
              output.write(
                `${sourceLabel}> [${recommendation.agent.toUpperCase()}] ${recommendation.action} — ${recommendation.reason}${cadenceNote}\n`,
              );
            });
          }
          
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
        const result = await callLLM("agent1", {
          messages,
          tools,
        });

        const assistantReply = result.text ?? "";

        let assistantMessageText = assistantReply.trim();

        if (assistantMessageText.length === 0 && pendingToolResponses.length > 0) {
          assistantMessageText = pendingToolResponses.join("\n");
          output.write(`mill> ${assistantMessageText}\n`);
        } else if (assistantMessageText.length > 0) {
          output.write(`mill> ${assistantMessageText}\n`);
        }

        const assistantMessages = (result.response?.messages ?? []) as ModelMessage[];

        if (assistantMessageText.length > 0 && assistantReply.trim().length === 0) {
          assistantMessages.push(createAssistantMessage(assistantMessageText));
        }

        const updatedHistory = [...conversationContext, userMessage, ...assistantMessages];
        writeHistory(history, updatedHistory, maxHistory);
        pendingToolResponses.length = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.write(`mill> Oops, my circuits fizzled: ${message}. Try again?\n`);
        pendingToolResponses.length = 0;
      }
    }
  } finally {
    devAlertsActive = false;
    anomalyAlertsActive = false;
    duplicateAlertsActive = false;

    if (stopAnomalyListener) {
      try {
        stopAnomalyListener();
      } catch (error) {
        console.error("[dev-agent] Failed to stop alert listener", error);
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

const SERA_KEYWORDS = [
  "search",
  "find",
  "buy",
  "shop",
  "shopping",
  "product",
  "price",
  "compare",
  "wishlist",
  "deal",
  "best deal",
  "recommend",
  "gadget",
  "watch",
  "laptop",
  "phone",
  "headphones",
  "shoes",
  "clothing",
  "appliance",
];

const SERA_EXIT_PHRASES = [
  "back to mill",
  "back to finance",
  "done shopping",
  "stop shopping",
  "return to mill",
  "switch to mill",
  "no more shopping",
  "back to money",
  "cancel shopping",
];

const SERA_STORE_REGEX = /amazon|flipkart|croma|myntra|ajio|tatacliq|reliance digital|nykaa|decathlon|ikea|chromawww|vijay sales|snapdeal|paytm mall/;
const SERA_VERB_REGEX = /buy|shop|shopping|wishlist|compare|deal|product|price|purchase|order|best|recommend|search/;

function shouldTriggerSera(input: string): boolean {
  if (!input) {
    return false;
  }

  const lower = input.toLowerCase();

  if (lower.includes("sera")) {
    return true;
  }

  const keywordHits = keywordScore(SERA_KEYWORDS, lower);
  const hasStoreMention = SERA_STORE_REGEX.test(lower);
  const hasShoppingVerb = SERA_VERB_REGEX.test(lower);
  const transactionCue = looksLikeTransactionIntent(lower);

  if (transactionCue && !hasStoreMention && !hasShoppingVerb) {
    return false;
  }

  return hasStoreMention || hasShoppingVerb || keywordHits > 0;
}

function shouldExitSera(input: string): boolean {
  if (!input) {
    return false;
  }

  const lower = input.toLowerCase();
  return SERA_EXIT_PHRASES.some((phrase) => lower.includes(phrase));
}

function keywordScore(keywords: readonly string[], lower: string): number {
  return keywords.reduce((score, keyword) => (lower.includes(keyword) ? score + 1 : score), 0);
}

function looksLikeTransactionIntent(lower: string): boolean {
  return /\b(spent|spend|pay|paid|log|record|salary|income|earned|received|deposit|withdraw|transfer|credited|debited)\b/.test(
    lower,
  );
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

/**
 * Load habit records from API (database)
 */
async function loadHabitRecords(): Promise<HabitRecord[]> {
  try {
    const ownerId = process.env.DEV_USER_ID ? parseInt(process.env.DEV_USER_ID, 10) : undefined;
    const habits = await fetchHabitsFromApi(ownerId);
    
    return habits.map((habit: any) => ({
      habitLabel: habit.habit_label || habit.habitLabel || "",
      evidence: habit.evidence || "",
      counsel: habit.counsel || "",
      fullText: habit.full_text || habit.fullText || "",
    }));
  } catch (error) {
    console.error("[chatbot] Failed to load habits from API:", error);
    return [];
  }
}

/**
 * Load latest coach briefing from API (database)
 */
async function loadLatestCoachBriefing(): Promise<CoachBriefing | null> {
  try {
    const ownerId = process.env.DEV_USER_ID ? parseInt(process.env.DEV_USER_ID, 10) : undefined;
    const briefings = await fetchCoachBriefingsFromApi(ownerId);
    
    if (!briefings || briefings.length === 0) {
      return null;
    }
    
    // Sort by date and get the most recent
    const sorted = briefings.sort((a: any, b: any) => {
      const dateA = new Date(a.date_created || a.createdAt || 0).getTime();
      const dateB = new Date(b.date_created || b.createdAt || 0).getTime();
      return dateB - dateA;
    });
    
    const latest = sorted[0];
    return {
      id: latest.id || "",
      createdAt: latest.date_created || latest.createdAt || new Date().toISOString(),
      headline: latest.headline || "",
      counsel: latest.counsel || "",
      evidence: latest.evidence || "",
      insightHash: latest.insight_hash || latest.insightHash || "",
      trigger: latest.trigger || "manual",
    };
  } catch (error) {
    console.error("[chatbot] Failed to load coach briefing from API:", error);
    return null;
  }
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

function formatLogAck(
  payload: LogCashTransactionPayload,
  normalized: NormalizedTransaction | null,
  flavor: CategorizationResult["flavor"],
): string {
  const direction = payload.direction === "income" ? "income" : "expense";
  const description = (normalized?.description ?? payload.description).trim();
  const category = (normalized?.category ?? payload.category_suggestion).trim();
  const eventDate = normalized?.eventDate?.trim();
  const currency = (normalized?.currency ?? "INR").trim() || "INR";
  const formattedAmount = formatCurrency(payload.amount, currency);
  const vibe = payload.direction === "income" ? "💸" : flavor === "luxury" ? "🎉" : flavor === "treat" ? "😋" : "✅";
  const directionPhrase = payload.direction === "income" ? "from" : "for";
  const categorySnippet = category.length > 0 ? ` (${category})` : "";
  const dateSnippet = eventDate ? ` on ${eventDate}` : "";
  const descriptionSnippet = description.length > 0 ? `${directionPhrase} ${description}` : "";
  const spacing = descriptionSnippet.length > 0 ? ` ${descriptionSnippet}` : "";

  return `${vibe} Logged ${formattedAmount}${spacing}${categorySnippet}${dateSnippet}.`;
}

function formatCurrency(amount: number, currency: string): string {
  const decimals = Math.abs(amount - Math.round(amount)) < 1e-9 ? 0 : 2;
  const formatted = amount.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${currency} ${formatted}`;
}

function buildDevNotification(transaction: NormalizedTransaction): string {
  const currency = transaction.currency?.trim().length ? transaction.currency : "INR";
  const amountLabel = formatCurrency(transaction.amount, currency);
  const directionWord = transaction.direction === "income" ? "credit" : "expense";
  const originSuffix = transaction.meta.source?.includes("sms") ? " from an SMS" : "";
  const analysis = analyzeTransactionCompleteness(transaction);

  const detailSegments: string[] = [];
  if (analysis.description) {
    detailSegments.push(`for ${analysis.description}`);
  }
  if (transaction.meta.targetParty) {
    detailSegments.push(`with ${transaction.meta.targetParty}`);
  }
  if (transaction.meta.medium) {
    detailSegments.push(`via ${transaction.meta.medium.toUpperCase()}`);
  }
  if (transaction.eventDate) {
    detailSegments.push(`on ${transaction.eventDate}`);
  }

  const details = detailSegments.length > 0 ? ` ${detailSegments.join(" ")}` : "";

  if (analysis.missingFields.length === 0) {
    return `FYI: I auto-logged ${amountLabel} as an ${directionWord}${details}${originSuffix}. Let me know if anything needs a tweak.`;
  }

  const missingLabel = formatMissingFields(analysis.missingFields);
  return `Heads up: I saw ${amountLabel} treated as an ${directionWord}${details}${originSuffix}, but I still need the ${missingLabel}. Could you fill that in?`;
}

function analyzeTransactionCompleteness(transaction: NormalizedTransaction): {
  missingFields: string[];
  description: string | null;
} {
  const missing = new Set<string>();
  const description = transaction.description?.trim() ?? "";
  const meaningfulDescription = hasMeaningfulDescription(description) ? description : null;

  if (!meaningfulDescription) {
    missing.add("description");
  }

  if (isFallbackCategory(transaction.category)) {
    missing.add("category");
  }

  if (transaction.direction === "expense" && !transaction.meta.targetParty) {
    missing.add("merchant");
  }

  if (!transaction.eventDate || transaction.eventDate.trim().length === 0) {
    missing.add("date");
  }

  return {
    missingFields: Array.from(missing),
    description: meaningfulDescription,
  };
}

const FALLBACK_CATEGORY_SET = new Set<string>([
  "Other Expense",
  "Other Income",
  "General Expense",
  "High-Value Expense",
  "Everyday Expense",
]);

function isFallbackCategory(category: string): boolean {
  if (!category) {
    return true;
  }
  return FALLBACK_CATEGORY_SET.has(category);
}

const GENERIC_DESCRIPTION_TOKENS = new Set<string>([
  "transaction",
  "credit",
  "credited",
  "debit",
  "debited",
  "payment",
  "upi payment",
  "upi txn",
  "upi transaction",
  "card payment",
  "purchase",
]);

function hasMeaningfulDescription(description: string): boolean {
  const normalized = description.trim().toLowerCase();
  if (normalized.length < 4) {
    return false;
  }

  if (GENERIC_DESCRIPTION_TOKENS.has(normalized)) {
    return false;
  }

  return true;
}

function formatMissingFields(fields: string[]): string {
  if (fields.length === 0) {
    return "details";
  }

  const labels = fields.map((field) => {
    switch (field) {
      case "description":
        return "description";
      case "category":
        return "category";
      case "merchant":
        return "merchant name";
      case "date":
        return "date";
      default:
        return field;
    }
  });

  if (labels.length === 1) {
    return labels[0] ?? "detail";
  }

  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }

  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
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

  if (normalized?.meta.alerts && normalized.meta.alerts.length > 0) {
    for (const alert of normalized.meta.alerts) {
      const icon = alert.severity === "high" ? "🚨" : alert.severity === "medium" ? "⚠️" : "ℹ️";
      output.write(
        `[tool] ${icon} anomaly_${alert.rule} => ${alert.summary}\n`,
      );
    }
  }
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

function getSeverityIcon(severity: AlertRecord["severity"]): string {
  switch (severity) {
    case "high":
      return "🚨";
    case "medium":
      return "⚠️";
    default:
      return "ℹ️";
  }
}

function formatAlertRule(rule: string): string {
  return rule
    .split(/[_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function composeAlertGuidance(
  severity: AlertRecord["severity"],
  classification: BehaviorMatch["classification"] | "unknown",
): string {
  if (severity === "high" || classification === "flagged") {
    return "Let's double-check this right away—if you don't recognize it, reach out to your bank immediately.";
  }

  if (severity === "medium" || classification === "unusual") {
    return "Can you confirm if this was expected? If anything feels off, keep an eye on your account and statements.";
  }

  if (classification === "expected" || classification === "borderline") {
    return "This lines up with your usual pattern—just give it a quick glance to be sure.";
  }

  return "Give it a quick confirmation so your records stay accurate.";
}

function describeAlertTransaction(alert: AlertRecord): string | undefined {
  const details = alert.details;
  if (!details || typeof details !== "object") {
    return undefined;
  }

  const transaction = (details as Record<string, unknown>).transaction;
  if (!transaction || typeof transaction !== "object") {
    return undefined;
  }

  const record = transaction as Record<string, unknown>;
  const amountRaw = record.amount;
  const amountValue = typeof amountRaw === "number" && Number.isFinite(amountRaw) ? amountRaw : undefined;
  const currencyRaw = record.currency;
  const currency = typeof currencyRaw === "string" && currencyRaw.trim().length > 0
    ? currencyRaw.trim().toUpperCase()
    : undefined;
  const directionRaw = record.direction;
  const direction = directionRaw === "income" || directionRaw === "expense" ? directionRaw : undefined;
  const targetRaw = record.targetParty;
  const targetParty = typeof targetRaw === "string" && targetRaw.trim().length > 0 ? targetRaw.trim() : undefined;

  const directionLabel = direction === "income" ? "Income" : direction === "expense" ? "Expense" : "Transaction";
  let amountLabel = "unknown amount";
  if (amountValue !== undefined) {
    const decimals = amountValue % 1 === 0 ? 0 : 2;
    const formatted = amountValue.toLocaleString("en-IN", {
      maximumFractionDigits: decimals,
      minimumFractionDigits: decimals,
    });
    amountLabel = `${currency ?? "INR"} ${formatted}`;
  }

  const targetLabel = targetParty ? ` involving ${targetParty}` : "";
  return `${directionLabel} ${amountLabel}${targetLabel}`;
}

interface BehaviorNarrative {
  summary: string;
  classification?: BehaviorMatch["classification"];
}

function summarizeBehaviorContext(alert: AlertRecord): BehaviorNarrative | undefined {
  const context = extractBehaviorContext(alert);
  if (!context) {
    return undefined;
  }

  const best = context.bestMatch;
  if (!best) {
    if (context.matches && context.matches.length > 0) {
      return {
        summary: "Behavior context collected, but no dominant baseline identified yet.",
      };
    }
    return {
      summary: "Behavior context unavailable.",
    };
  }

  const classificationLabel = best.classification.toUpperCase();
  const riskLabel = best.riskLevel ? `, risk ${best.riskLevel}` : "";
  const sampleLabel = typeof best.sampleCount === "number" && best.sampleCount > 0
    ? ` from ${best.sampleCount} samples`
    : "";
  return {
    summary: `Behavior context (${classificationLabel}${riskLabel}${sampleLabel}): ${best.message}`,
    classification: best.classification,
  };
}

function extractBehaviorContext(alert: AlertRecord):
  | { bestMatch?: BehaviorMatch; matches?: BehaviorMatch[] }
  | undefined {
  const details = alert.details;
  if (!details || typeof details !== "object") {
    return undefined;
  }

  const rawContext = (details as Record<string, unknown>).behaviorContext;
  if (!rawContext || typeof rawContext !== "object") {
    return undefined;
  }

  const contextRecord = rawContext as Record<string, unknown>;
  const bestMatchRaw = contextRecord.bestMatch;
  const bestMatch = isBehaviorMatch(bestMatchRaw) ? bestMatchRaw : undefined;

  const matchesRaw = contextRecord.matches;
  const matches = Array.isArray(matchesRaw)
    ? matchesRaw.map((entry) => (isBehaviorMatch(entry) ? entry : undefined)).filter(Boolean) as BehaviorMatch[]
    : undefined;

  return {
    ...(bestMatch ? { bestMatch } : {}),
    ...(matches && matches.length > 0 ? { matches } : {}),
  };
}

function isBehaviorMatch(candidate: unknown): candidate is BehaviorMatch {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }

  const record = candidate as BehaviorMatch & Record<string, unknown>;
  return typeof record.classification === "string" && typeof record.message === "string";
}
