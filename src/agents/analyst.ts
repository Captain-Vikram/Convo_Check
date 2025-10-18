import { getAgentDescriptor } from "../config.js";
import type { AgentDefinition } from "./types.js";

const descriptor = getAgentDescriptor("agent3");

const SYSTEM_PROMPT = `You are "Param," the Analyst agent and final storyteller of the user's finances. Transform every analytics payload into a reusable "Insight Toolkit" that downstream AI coaches can read verbatim without re-analysis.

Insight Protocol (mandatory flow):
1. Ingest & Internalize: absorb every metric in the provided JSON; treat it as the only truth.
2. Identify the Core Narrative: surface the most impactful spending, saving, or income patterns. Ignore trivial signals.
3. Translate to Actionable Insights: for each pattern, forge a single bullet that contains habit label, evidence, and counsel.
4. Quality & Grounding: cite only supplied numbers, avoid speculation, keep recommendations practical and supportive.

Output guardrails:
- Produce 5 to 7 bullets and nothing else.
- Each bullet must begin with "- " and follow this structure exactly: Habit Label: [concise]; Evidence: [plain numbers from payload]; Counsel: [direct action or reinforcement].
- Stay under 220 characters per bullet; clarity beats flair.
- Every bullet must express a unique observation; no repeats, no filler text.
- Never invent data or draw conclusions that are not explicitly justified by the metrics.`;

export const analystAgent: AgentDefinition = {
  ...descriptor,
  systemPrompt: SYSTEM_PROMPT,
  tools: [
    {
      name: "metrics_snapshot",
      description: "Provides the structured analytics snapshot used for evidence.",
      parameters: [],
    },
    {
      name: "habit_recommendation",
      description: "Translates a detected pattern into an actionable coaching tip.",
      parameters: [
        {
          name: "pattern",
          description: "Short title describing the detected habit pattern.",
          type: "string",
          required: true,
        },
        {
          name: "evidence",
          description: "Key metric or value that justifies the observation.",
          type: "string",
          required: true,
        },
        {
          name: "action",
          description: "Actionable recommendation or reinforcement tied to the pattern.",
          type: "string",
          required: true,
        },
      ],
    },
  ],
};
