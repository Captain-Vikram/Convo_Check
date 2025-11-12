import { createHash, randomUUID } from "node:crypto";

import { callLLM } from "../shared/llm-client.js";
import { 
  syncCoachBriefingToApi, 
  fetchCoachBriefingsFromApi, 
  fetchHabitsFromApi,
  type CoachBriefingPayload 
} from "../dev/api-sync.js";
import { logger } from "../shared/logger.js";
import { coachAgent } from "../../agents/coach.js";
import type { HabitInsight } from "../param/analyst-agent.js";

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
 * Load habit insights from API (database)
 */
async function loadHabitInsights(): Promise<HabitInsight[]> {
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
    logger.error("coach-agent", "Failed to load habits from API", error);
    return [];
  }
}

async function persistBriefing(briefing: CoachBriefing): Promise<void> {
  // Persist to database via API
  try {
    const ownerId = process.env.DEV_USER_ID ? parseInt(process.env.DEV_USER_ID, 10) : undefined;
    
    const briefingPayload: CoachBriefingPayload = {
      headline: briefing.headline,
      counsel: briefing.counsel,
      evidence: briefing.evidence,
      insightHash: briefing.insightHash,
      ...(briefing.trigger && { trigger: briefing.trigger }),
      ...(ownerId && { owner: ownerId }),
      metadata: {
        originalId: briefing.id,
        createdAt: briefing.createdAt,
      },
    };
    
    await syncCoachBriefingToApi(briefingPayload);
  } catch (error) {
    logger.error("coach-agent", "Failed to sync briefing to API", error);
    throw error; // Re-throw to signal persistence failure
  }
}

/**
 * Load coach briefings from API (database)
 */
async function loadBriefings(): Promise<CoachBriefing[]> {
  try {
    const ownerId = process.env.DEV_USER_ID ? parseInt(process.env.DEV_USER_ID, 10) : undefined;
    const briefings = await fetchCoachBriefingsFromApi(ownerId);
    
    return briefings.map((b: any) => ({
      id: b.id || b.originalId || "",
      createdAt: b.date_created || b.createdAt || new Date().toISOString(),
      headline: b.headline || "",
      counsel: b.counsel || "",
      evidence: b.evidence || "",
      insightHash: b.insight_hash || b.insightHash || "",
      trigger: b.trigger || "manual",
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