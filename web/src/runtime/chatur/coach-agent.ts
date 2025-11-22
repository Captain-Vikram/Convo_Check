import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "../../../../data/generated/prisma";
import { callLLM } from "../shared/llm-client";
import { prisma } from "@/lib/prisma";
import { logger } from "../shared/logger";
import { coachAgent } from "@/agents/coach";
import {
  embedQuestion,
  hashQuestion,
  cosineSimilarity,
  parseEmbedding,
} from "../shared/memory-utils";
import { runAnalyst } from "../param/analyst-agent";
// TODO: Param agent is stubbed
// import type { HabitInsight } from "../param/analyst-agent";
type HabitInsight = any;
import {
  createGroundedSearchTool,
  callGroundedSearchProvider,
  groundedSearchToolDefinition,
} from "@/tools/grounded-search";

const coachTools = {
  [groundedSearchToolDefinition.name]: createGroundedSearchTool(callGroundedSearchProvider),
} as const;

const HOURS_IN_MS = 60 * 60 * 1000;

function parseRateLimitWindow(perDayRaw?: string, hoursRaw?: string, fallbackHours = 24): number {
  if (perDayRaw) {
    const runsPerDay = Number(perDayRaw);
    if (Number.isFinite(runsPerDay) && runsPerDay > 0) {
      return Math.max((24 / runsPerDay) * HOURS_IN_MS, HOURS_IN_MS);
    }
  }

  if (hoursRaw) {
    const intervalHours = Number(hoursRaw);
    if (Number.isFinite(intervalHours) && intervalHours > 0) {
      return Math.max(intervalHours * HOURS_IN_MS, HOURS_IN_MS);
    }
  }

  return fallbackHours * HOURS_IN_MS;
}

function getCoachRateLimitMs(): number {
  return parseRateLimitWindow(
    process.env.CHATUR_MAX_RUNS_PER_DAY ?? process.env.MAX_RUNS_PER_DAY,
    process.env.CHATUR_RATE_LIMIT_HOURS,
    24,
  );
}

const BRIEFING_SELECT = {
  id: true,
  owner: true,
  headline: true,
  counsel: true,
  evidence: true,
  insight_hash: true,
  delivered: true,
  delivered_at: true,
  date_created: true,
  user_question: true,
  agent_answer: true,
  insights_used: true,
  question_hash: true,
  question_embedding: true,
  answer_version: true,
  snapshot: true,
} satisfies Prisma.coach_briefingsSelect;

export interface CoachRunOptions {
  latestInsights?: HabitInsight[];
  previousInsights?: HabitInsight[];
  trigger?: "analyst" | "manual" | "user" | "daily";
  question?: string;
  ownerId?: number;
  forceRefresh?: boolean;
}

export interface CoachBriefing {
  id: string;
  createdAt: string;
  headline: string;
  counsel: string;
  evidence: string;
  insightHash: string;
  question?: string;
  questionHash?: string;
  answerVersion?: number;
  insightsUsed?: string[];
  storedAnswer?: string;
  delivered: boolean;
  deliveredAt?: string;
  snapshotId?: number;
}

type CoachBriefingRecord = Prisma.coach_briefingsGetPayload<{ select: typeof BRIEFING_SELECT }>;

interface HabitInsightRecord extends HabitInsight {
  id: number;
  habitId: string;
  updatedAt: Date;
  recordedAt: Date;
}

function resolveOwner(ownerId?: number): number {
  if (typeof ownerId === "number" && Number.isFinite(ownerId)) {
    return ownerId;
  }

  const configured = process.env.DEV_USER_ID ? parseInt(process.env.DEV_USER_ID, 10) : NaN;
  return Number.isFinite(configured) ? configured : 1;
}

function mapIncomingInsights(items: HabitInsight[]): HabitInsightRecord[] {
  const timestamp = new Date();
  return items.map((insight, index) => ({
    id: index,
    habitId: insight.habitLabel ? `external-${insight.habitLabel}-${index}` : `external-${index}`,
    habitLabel: insight.habitLabel ?? "",
    evidence: insight.evidence ?? "",
    counsel: insight.counsel ?? "",
    fullText: insight.fullText ?? `${insight.habitLabel ?? "Habit"}: ${insight.counsel ?? ""}`,
    recordedAt: timestamp,
    updatedAt: timestamp,
  }));
}

interface FreshInsightsResult {
  insights: HabitInsightRecord[];
  refreshed: boolean;
  latestUpdatedAt: Date | null;
}

const DAILY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function ensureInsightFreshness(ownerId: number): Promise<FreshInsightsResult> {
  const insights = await loadHabitInsights(ownerId);
  const latestUpdatedAt = getLatestInsightUpdatedAt(insights);

  try {
    const cursor = await prisma.habit_processing_cursors.findUnique({
      where: { owner: ownerId },
      select: { last_transaction_at: true, last_run_at: true },
    });

    const now = new Date();
    const lastRunTooOld = !cursor?.last_run_at
      ? true
      : now.getTime() - cursor.last_run_at.getTime() > DAILY_REFRESH_INTERVAL_MS;
    const hasNewTransactions = Boolean(
      cursor?.last_transaction_at &&
      (!latestUpdatedAt || cursor.last_transaction_at > latestUpdatedAt),
    );
    const needsRefresh = hasNewTransactions || lastRunTooOld;
    const forceReplay = lastRunTooOld && !hasNewTransactions;

    if (!needsRefresh) {
      return { insights, refreshed: false, latestUpdatedAt };
    }

    logger.info("coach-agent", "Triggering Param for fresh insights", { ownerId });
    const result = await runAnalyst({
      ownerId,
      trigger: "chatur",
      reanalyzeAll: forceReplay,
    });
    if (result.status === "success" && result.newInsightsAvailable) {
      const refreshed = await loadHabitInsights(ownerId);
      return {
        insights: refreshed,
        refreshed: true,
        latestUpdatedAt: getLatestInsightUpdatedAt(refreshed),
      };
    }
  } catch (error) {
    logger.error("coach-agent", "Failed to refresh insights", error, { ownerId });
  }

  return { insights, refreshed: false, latestUpdatedAt };
}

function getLatestInsightUpdatedAt(insights: HabitInsightRecord[]): Date | null {
  if (insights.length === 0) {
    return null;
  }

  return insights.reduce<Date | null>((latest, insight) => {
    const updated = insight.updatedAt;
    if (!latest || (updated && updated > latest)) {
      return updated;
    }
    return latest;
  }, null);
}

export async function runCoach(options: CoachRunOptions = {}): Promise<CoachBriefing | null> {
  const ownerId = resolveOwner(options.ownerId);
  const normalizedQuestion = options.question?.trim();
  const questionHash = normalizedQuestion ? hashQuestion(normalizedQuestion) : undefined;
  const questionEmbedding = normalizedQuestion ? embedQuestion(normalizedQuestion) : undefined;
  const triggerSource = options.trigger ?? (normalizedQuestion ? "user" : "manual");

  logger.debug("coach-agent", "Starting coach run", {
    ownerId,
    trigger: triggerSource,
    hasQuestion: Boolean(normalizedQuestion),
  });

  const adhocInsights = options.latestInsights && options.latestInsights.length > 0
    ? mapIncomingInsights(options.latestInsights)
    : null;

  const freshness = adhocInsights
    ? {
        insights: adhocInsights,
        refreshed: false,
        latestUpdatedAt: getLatestInsightUpdatedAt(adhocInsights),
      }
    : await ensureInsightFreshness(ownerId);

  const insights = freshness.insights;
  const latestInsightUpdatedAt = freshness.latestUpdatedAt;

  if (insights.length === 0) {
    logger.warn("coach-agent", "Skipping run: no analyst insights available", { ownerId });
    return null;
  }

  const insightHash = hashInsights(insights);
  let existingBriefing: CoachBriefingRecord | null = null;
  let briefingSource: "question-cache" | "insight-cache" | "recent" | null = null;

  if (normalizedQuestion) {
    existingBriefing = await findMatchingBriefing(ownerId, questionHash, questionEmbedding);
    if (existingBriefing) {
      briefingSource = "question-cache";
    } else {
      existingBriefing = await findInsightAlignedBriefing(ownerId, insightHash, questionEmbedding);
      if (existingBriefing) {
        briefingSource = "insight-cache";
      }
    }
  } else {
    existingBriefing = await loadMostRecentBriefingRecord(ownerId);
    if (existingBriefing) {
      briefingSource = "recent";
    }
  }
    let recentBriefingRecord = existingBriefing;
    if (!recentBriefingRecord) {
      recentBriefingRecord = await loadMostRecentBriefingRecord(ownerId);
    }

    const existingUpdatedAt = existingBriefing?.date_created ?? null;
    const withinCoachRateLimit = Boolean(
      recentBriefingRecord && Date.now() - recentBriefingRecord.date_created.getTime() < getCoachRateLimitMs(),
    );

    if (
      normalizedQuestion &&
      !options.forceRefresh &&
      !existingBriefing &&
      recentBriefingRecord &&
      recentBriefingRecord.insight_hash === insightHash &&
      withinCoachRateLimit
    ) {
      logger.debug("coach-agent", "Rate limited: returning latest briefing for unmatched question", {
        ownerId,
        questionHash,
        briefingId: recentBriefingRecord.id,
      });
      return mapBriefing(recentBriefingRecord);
    }

  if (
    existingBriefing &&
    !options.forceRefresh &&
    !normalizedQuestion &&
    existingBriefing.insight_hash === insightHash &&
    (!latestInsightUpdatedAt || (existingUpdatedAt && existingUpdatedAt >= latestInsightUpdatedAt))
  ) {
    logger.debug("coach-agent", "Insights unchanged; reusing previous briefing", {
      ownerId,
      briefingId: existingBriefing.id,
      source: briefingSource,
    });
    return mapBriefing(existingBriefing);
  }

  if (
    existingBriefing &&
    !options.forceRefresh &&
    existingBriefing.insight_hash === insightHash &&
    normalizedQuestion &&
    (!latestInsightUpdatedAt || (existingUpdatedAt && existingUpdatedAt >= latestInsightUpdatedAt))
  ) {
    logger.debug("coach-agent", "Reusing cached briefing", {
      ownerId,
      questionHash,
      briefingId: existingBriefing.id,
      source: briefingSource,
    });
    return mapBriefing(existingBriefing);
  }

  const prompt = buildCoachPrompt(insights, options.previousInsights ?? null, options.question);
  const coachResponse = await callCoachModel(prompt);
  if (!coachResponse) {
    return null;
  }

  const persisted = await persistBriefingRecord({
    ownerId,
    question: normalizedQuestion,
    questionHash,
    questionEmbedding,
    insightHash,
    response: coachResponse,
    insights,
    replaceId:
      existingBriefing && questionHash && existingBriefing.question_hash === questionHash
        ? existingBriefing.id
        : undefined,
  });

  return mapBriefing(persisted);
}

interface CoachModelPayload {
  headline: string;
  counsel: string;
  evidence: string;
}

async function callCoachModel(prompt: string): Promise<CoachModelPayload | null> {
  try {
    const result = await callLLM("agent4", {
      messages: [
        { role: "system", content: coachAgent.systemPrompt },
        { role: "user", content: prompt },
      ],
      tools: coachTools,
    });

    const text = (result.text ?? "").trim();
    if (!text) {
      console.warn("[coach] Empty response from model.");
      return null;
    }

    const payload = extractJsonPayload(text);
    if (!payload) {
      console.warn("[coach] Response did not include JSON payload.");
      return null;
    }

    const parsed = JSON.parse(payload) as CoachModelPayload;

    if (!parsed.headline || !parsed.counsel || !parsed.evidence) {
      console.warn("[coach] Response missing required fields.");
      return null;
    }

    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[coach] Failed to generate guidance", message);
    return null;
  }
}

function extractJsonPayload(response: string): string | null {
  const fencedMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = response.indexOf("{");
  const lastBrace = response.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return response.slice(firstBrace, lastBrace + 1).trim();
  }

  const trimmed = response.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  return null;
}

function buildCoachPrompt(
  latest: HabitInsight[],
  previous: HabitInsight[] | null,
  question?: string,
): string {
  const lines: string[] = [];
  lines.push("Latest insights:");
  latest.forEach((insight, index) => {
    lines.push(`${index + 1}. ${insight.fullText}`);
  });

  if (previous && previous.length > 0) {
    lines.push("\nPreviously highlighted habits:");
    previous.forEach((insight, index) => {
      lines.push(`${index + 1}. ${insight.fullText}`);
    });
  }

  if (question && question.trim().length > 0) {
    lines.push("\nUser request:");
    lines.push(question.trim());
  }

  lines.push("\nProduce one headline, counsel sentence, and cite the key evidence string.");
  lines.push("Respond only with a JSON object that matches the specified output format.");
  return lines.join("\n");
}

/**
 * Load habit insights from database via Prisma
 */
async function loadHabitInsights(ownerId: number): Promise<HabitInsightRecord[]> {
  try {
    const habits = await prisma.habit_insights.findMany({
      where: { owner: ownerId, superseded: false },
      orderBy: [
        { updated_at: "desc" },
        { recorded_at: "desc" },
      ],
    });

    return habits.map((habit) => ({
      id: habit.id,
      habitId: habit.habit_id ?? `habit-${habit.id}`,
      habitLabel: habit.habit_label ?? "",
      evidence: habit.evidence ?? "",
      counsel: habit.counsel ?? "",
      fullText: habit.full_text ?? "",
      recordedAt: habit.recorded_at ?? new Date(),
      updatedAt: habit.updated_at ?? habit.recorded_at ?? new Date(),
    }));
  } catch (error) {
    logger.error("coach-agent", "Failed to load habits from database", error, { ownerId });
    return [];
  }
}

interface PersistBriefingInput {
  ownerId: number;
  question?: string | null;
  questionHash?: string;
  questionEmbedding?: number[];
  insightHash: string;
  response: CoachModelPayload;
  insights: HabitInsightRecord[];
  replaceId?: string;
}

async function persistBriefingRecord(input: PersistBriefingInput): Promise<CoachBriefingRecord> {
  const {
    ownerId,
    question,
    questionHash,
    questionEmbedding,
    insightHash,
    response,
    insights,
    replaceId,
  } = input;

  const insightRefs = insights.map((insight) => insight.habitId);
  const sharedData = {
    owner: ownerId,
    headline: response.headline,
    counsel: response.counsel,
    evidence: response.evidence ?? null,
    insight_hash: insightHash,
    user_question: question ?? null,
    agent_answer: JSON.stringify(response),
    insights_used: insightRefs,
    question_hash: questionHash ?? null,
    question_embedding: questionEmbedding ?? Prisma.JsonNull,
  };

  if (replaceId) {
    return prisma.coach_briefings.update({
      where: { id: replaceId },
      data: {
        ...sharedData,
        answer_version: { increment: 1 },
        date_created: new Date(),
      },
      select: BRIEFING_SELECT,
    });
  }

  return prisma.coach_briefings.create({
    data: {
      id: randomUUID(),
      date_created: new Date(),
      status: "Active",
      ...sharedData,
    },
    select: BRIEFING_SELECT,
  });
}

const SIMILARITY_THRESHOLD = 0.92;
const INSIGHT_REUSE_THRESHOLD = 0.8;

async function findMatchingBriefing(
  ownerId: number,
  questionHash?: string,
  questionEmbedding?: number[],
): Promise<CoachBriefingRecord | null> {
  if (questionHash) {
    const exact = await prisma.coach_briefings.findFirst({
      where: { owner: ownerId, question_hash: questionHash },
      orderBy: { date_created: "desc" },
      select: BRIEFING_SELECT,
    });

    if (exact) {
      return exact;
    }
  }

  if (!questionEmbedding || questionEmbedding.length === 0) {
    return null;
  }

  const recentBriefings = await prisma.coach_briefings.findMany({
    where: {
      owner: ownerId,
      NOT: [{ question_embedding: { equals: Prisma.JsonNull } }],
    },
    orderBy: { date_created: "desc" },
    take: 25,
    select: BRIEFING_SELECT,
  });

  let bestMatch: CoachBriefingRecord | null = null;
  let bestScore = SIMILARITY_THRESHOLD;

  for (const briefing of recentBriefings) {
    const embedding = parseEmbedding(briefing.question_embedding);
    if (!embedding || embedding.length === 0) {
      continue;
    }
    const score = cosineSimilarity(questionEmbedding, embedding);
    if (score > bestScore) {
      bestMatch = briefing;
      bestScore = score;
    }
  }

  return bestMatch;
}

async function findInsightAlignedBriefing(
  ownerId: number,
  insightHash: string,
  questionEmbedding?: number[],
): Promise<CoachBriefingRecord | null> {
  const candidates = await prisma.coach_briefings.findMany({
    where: { owner: ownerId, insight_hash: insightHash },
    orderBy: { date_created: "desc" },
    take: 25,
    select: BRIEFING_SELECT,
  });

  if (candidates.length === 0) {
    return null;
  }

  if (!questionEmbedding || questionEmbedding.length === 0) {
    return candidates[0] ?? null;
  }

  let bestMatch: CoachBriefingRecord | null = null;
  let bestScore = INSIGHT_REUSE_THRESHOLD;

  for (const candidate of candidates) {
    const embedding = parseEmbedding(candidate.question_embedding);
    if (!embedding || embedding.length === 0) {
      continue;
    }
    const score = cosineSimilarity(questionEmbedding, embedding);
    if (score > bestScore) {
      bestMatch = candidate;
      bestScore = score;
    }
  }

  return bestMatch;
}

async function loadMostRecentBriefingRecord(ownerId: number): Promise<CoachBriefingRecord | null> {
  const record = await prisma.coach_briefings.findFirst({
    where: { owner: ownerId },
    orderBy: { date_created: "desc" },
    select: BRIEFING_SELECT,
  });

  return record ?? null;
}

function mapBriefing(record: CoachBriefingRecord): CoachBriefing {
  return {
    id: record.id,
    createdAt: record.date_created.toISOString(),
    headline: record.headline ?? "",
    counsel: record.counsel ?? "",
    evidence: record.evidence ?? "",
    insightHash: record.insight_hash,
    question: record.user_question ?? undefined,
    questionHash: record.question_hash ?? undefined,
    answerVersion: record.answer_version ?? 1,
    insightsUsed: Array.isArray(record.insights_used)
      ? (record.insights_used as string[])
      : undefined,
    storedAnswer: typeof record.agent_answer === "string" ? record.agent_answer : undefined,
    delivered: Boolean(record.delivered),
    deliveredAt: record.delivered_at ? record.delivered_at.toISOString() : undefined,
    snapshotId: typeof record.snapshot === "number" ? record.snapshot : undefined,
  };
}

/**
 * Load coach briefings from database via Prisma
 */
async function loadBriefings(ownerId?: number): Promise<CoachBriefing[]> {
  try {
    const resolvedOwner = resolveOwner(ownerId);
    const briefings = await prisma.coach_briefings.findMany({
      where: { owner: resolvedOwner },
      orderBy: { date_created: "desc" },
      select: BRIEFING_SELECT,
    });

    return briefings.map(mapBriefing);
  } catch (error) {
    logger.error("coach-agent", "Failed to load briefings from API", error, { ownerId });
    return [];
  }
}

async function loadMostRecentBriefing(ownerId?: number): Promise<CoachBriefing | null> {
  const record = await loadMostRecentBriefingRecord(resolveOwner(ownerId));
  return record ? mapBriefing(record) : null;
}

function hashInsights(insights: HabitInsight[]): string {
  const hash = createHash("sha1");
  insights.forEach((entry) => {
    hash.update(entry.habitLabel ?? "");
    hash.update("|");
    hash.update(entry.evidence ?? "");
    hash.update("|");
    hash.update(entry.counsel ?? "");
    hash.update("\n");
  });
  return hash.digest("hex");
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;

    if (char === '"') {
      const next = line[index + 1];
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
}