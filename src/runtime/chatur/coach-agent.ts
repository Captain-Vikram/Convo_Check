import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

import { coachAgent } from "../../agents/coach.js";
import { getAgentConfig } from "../../config.js";
import type { HabitInsight } from "../param/analyst-agent.js";

const DATA_DIR = join(process.cwd(), "data");
const HABITS_FILE = join(DATA_DIR, "habits.csv");
const BRIEFINGS_FILE = join(DATA_DIR, "coach-briefings.json");
const SNAPSHOT_DIR = join(DATA_DIR, "habit-snapshots");

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
  const latest = options.latestInsights ?? (await loadHabitInsights(HABITS_FILE));

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
    const { apiKey, model } = getAgentConfig("agent4");
    const provider = createGoogleGenerativeAI({ apiKey });
    const languageModel = provider(model);

    const result = await generateText({
      model: languageModel,
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

async function loadHabitInsights(filePath: string): Promise<HabitInsight[]> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

    if (lines.length <= 1) {
      return [];
    }

    const insights: HabitInsight[] = [];
    for (let index = 1; index < lines.length; index += 1) {
      const values = parseCsvLine(lines[index]!);
      if (values.length < 4) {
        continue;
      }

      insights.push({
        habitLabel: values[0] ?? "",
        evidence: values[1] ?? "",
        counsel: values[2] ?? "",
        fullText: values[3] ?? "",
      });
    }

    return insights;
  } catch (error) {
    console.error("[coach] Failed to load habits.csv", error);
    return [];
  }
}

async function persistBriefing(briefing: CoachBriefing): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const existing = await loadBriefings();
  existing.push(briefing);
  await writeFile(BRIEFINGS_FILE, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

async function loadBriefings(): Promise<CoachBriefing[]> {
  try {
    const content = await readFile(BRIEFINGS_FILE, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is CoachBriefing => {
      return (
        entry &&
        typeof entry === "object" &&
        typeof (entry as CoachBriefing).id === "string" &&
        typeof (entry as CoachBriefing).headline === "string"
      );
    });
  } catch {
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

  return readInsightSnapshot(recent.insightHash);
}

async function readInsightSnapshot(hash: string): Promise<HabitInsight[] | null> {
  try {
    const snapshotFile = join(SNAPSHOT_DIR, `${hash}.json`);
    const content = await readFile(snapshotFile, "utf8");
    const parsed = JSON.parse(content) as HabitInsight[];
    return parsed;
  } catch {
    return null;
  }
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

async function persistInsightSnapshot(hash: string, insights: HabitInsight[]): Promise<void> {
  try {
    await mkdir(SNAPSHOT_DIR, { recursive: true });
    const snapshotFile = join(SNAPSHOT_DIR, `${hash}.json`);
    await writeFile(snapshotFile, `${JSON.stringify(insights, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error("[coach] Failed to persist insight snapshot", error);
  }
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