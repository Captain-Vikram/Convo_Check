import { createHash, randomUUID } from "node:crypto";

import { callLLM } from "../shared/llm-client";
import { prisma } from "@/lib/prisma";
import { logger } from "../shared/logger";
import { coachAgent } from "@/agents/coach";
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

export interface CoachRunOptions {
  latestInsights?: HabitInsight[];
  previousInsights?: HabitInsight[];
  trigger?: "analyst" | "manual";
  question?: string;
}

export interface CoachBriefing {
  id: string;
  createdAt: string;
  headline: string;
  counsel: string;
  evidence: string;
  insightHash: string;
  trigger: CoachRunOptions["trigger"];
}

export async function runCoach(options: CoachRunOptions = {}): Promise<CoachBriefing | null> {
  const latest = options.latestInsights ?? (await loadHabitInsights());

  if (!latest || latest.length === 0) {
    console.warn("[coach] Skipping run: no analyst insights available.");
    return null;
  }

  const previous = options.previousInsights ?? (await loadMostRecentBriefingInsights());
  const insightHash = hashInsights(latest);
  const mostRecent = await loadMostRecentBriefing();
  const hasQuestion = Boolean(options.question && options.question.trim().length > 0);

  if (mostRecent && mostRecent.insightHash === insightHash && !hasQuestion) {
    console.log("[coach] Insights unchanged; reusing prior briefing.");
    return mostRecent;
  }

  const prompt = buildCoachPrompt(latest, previous, options.question);
  const coachResponse = await callCoachModel(prompt);

  if (!coachResponse) {
    return null;
  }

  const briefing: CoachBriefing = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    headline: coachResponse.headline,
    counsel: coachResponse.counsel,
    evidence: coachResponse.evidence,
    insightHash,
    trigger: options.trigger ?? "manual",
  };

  if (hasQuestion) {
    return briefing;
  }

  await persistInsightSnapshot(insightHash, latest);
  await persistBriefing(briefing);
  return briefing;
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
async function loadHabitInsights(): Promise<HabitInsight[]> {
  try {
    const ownerId = process.env.DEV_USER_ID ? parseInt(process.env.DEV_USER_ID, 10) : 1;
    const habits = await prisma.habit_insights.findMany({
      where: { owner: ownerId },
      orderBy: { recorded_at: 'desc' }
    });
    
    return habits.map((habit) => ({
      habitLabel: habit.habit_label || "",
      evidence: habit.evidence || "",
      counsel: habit.counsel || "",
      fullText: habit.full_text || "",
    }));
  } catch (error) {
    logger.error("coach-agent", "Failed to load habits from database", error);
    return [];
  }
}

async function persistBriefing(briefing: CoachBriefing): Promise<void> {
  // Persist to database via Prisma
  try {
    const ownerId = process.env.DEV_USER_ID ? parseInt(process.env.DEV_USER_ID, 10) : 1;
    const { randomUUID } = await import('node:crypto');
    
    await prisma.coach_briefings.create({
      data: {
        id: randomUUID(),
        owner: ownerId,
        headline: briefing.headline,
        counsel: briefing.counsel,
        evidence: briefing.evidence || null,
        insight_hash: briefing.insightHash,
        trigger: briefing.trigger || null,
        metadata: {
          originalId: briefing.id,
          createdAt: briefing.createdAt,
        } as any,
        date_created: new Date(),
      },
    });
  } catch (error) {
    logger.error("coach-agent", "Failed to sync briefing to database", error);
    throw error; // Re-throw to signal persistence failure
  }
}

/**
 * Load coach briefings from database via Prisma
 */
async function loadBriefings(): Promise<CoachBriefing[]> {
  try {
    const ownerId = process.env.DEV_USER_ID ? parseInt(process.env.DEV_USER_ID, 10) : 1;
    const briefings = await prisma.coach_briefings.findMany({
      where: { owner: ownerId },
      orderBy: { date_created: 'desc' }
    });
    
    return briefings.map((b) => ({
      id: b.id,
      createdAt: b.date_created.toISOString(),
      headline: b.headline,
      counsel: b.counsel,
      evidence: b.evidence || "",
      insightHash: b.insight_hash,
      trigger: (b.trigger === "analyst" || b.trigger === "manual") ? b.trigger : undefined,
    }));
  } catch (error) {
    logger.error("coach-agent", "Failed to load briefings from API", error);
    return [];
  }
}

async function loadMostRecentBriefing(): Promise<CoachBriefing | null> {
  const briefings = await loadBriefings();
  if (briefings.length === 0) {
    return null;
  }

  briefings.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return briefings[0] ?? null;
}

async function loadMostRecentBriefingInsights(): Promise<HabitInsight[] | null> {
  const recent = await loadMostRecentBriefing();
  if (!recent) {
    return null;
  }

  // Since we no longer have snapshots, just load all current habits
  // The hash comparison will still work to detect changes
  return loadHabitInsights();
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

/**
 * No longer persisting snapshots - using live DB data instead
 */
async function persistInsightSnapshot(_hash: string, _insights: HabitInsight[]): Promise<void> {
  // No-op: Snapshots are no longer stored locally
  // The hash comparison still works to detect if insights have changed
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