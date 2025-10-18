import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { z } from "zod";

import { devAgent } from "../../agents/dev.js";
import { getAgentConfig } from "../../config.js";
import type { SmsMessage } from "./dev-sms-agent.js";

const DATE_CONTEXT_LABEL = "Monday, October 13, 2025";
const DATE_CONTEXT_ISO = "2025-10-13";

type GoogleModelProvider = ReturnType<typeof createGoogleGenerativeAI>;
type GoogleLanguageModel = ReturnType<GoogleModelProvider>;

const extractionSchema = z.object({
  amount: z.coerce.number(),
  type: z.enum(["credit", "debit"]),
  targetParty: z.string().trim(),
  currency: z.string().trim().min(1),
  medium: z.enum(["upi", "card", "bank", "other"]),
  category: z.string().trim().min(1),
  description: z.string().trim().min(1),
  date_of_transaction: z
    .string()
    .trim()
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "Invalid ISO date",
    }),
});

export type DevExtraction = z.infer<typeof extractionSchema>;

let cachedModel: GoogleLanguageModel | undefined;
let modelInitializationFailed = false;

function ensureLanguageModel(): GoogleLanguageModel | undefined {
  if (modelInitializationFailed) {
    return undefined;
  }

  if (!cachedModel) {
    try {
      const { apiKey, model } = getAgentConfig("agent2");
      const provider = createGoogleGenerativeAI({ apiKey });
      cachedModel = provider(model);
    } catch (error) {
      modelInitializationFailed = true;
      const message = error instanceof Error ? error.message : String(error);
      console.error("[dev-llm-parser] Gemini configuration unavailable", message);
      return undefined;
    }
  }

  return cachedModel;
}

export async function extractTransactionFromSms(
  message: SmsMessage,
): Promise<DevExtraction | null> {
  try {
    const languageModel = ensureLanguageModel();
    if (!languageModel) {
      return null;
    }
    const prompt = buildPrompt(message);
    
    const result = await generateText({
      model: languageModel,
      messages: [
        { role: "system", content: devAgent.systemPrompt },
        { role: "user", content: prompt },
      ],
    });

    const raw = (result.text ?? "").trim();

    if (raw.length === 0) {
      return null;
    }

    if (raw === "null") {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    const validation = extractionSchema.safeParse(parsed);

    if (!validation.success) {
      console.error("[dev-llm-parser] Extraction schema mismatch", validation.error.flatten());
      return null;
    }

    const normalized = sanitizeExtraction(validation.data);
    return normalized;
  } catch (error) {
    console.error("[dev-llm-parser] Failed to extract transaction", {
      error,
      sender: message.sender,
    });
    return null;
  }
}

function buildPrompt(message: SmsMessage): string {
  const body = message.message ?? "";
  const sender = message.sender ?? "";
  const senderName = message.senderName?.trim();
  const senderLabel = senderName && senderName.length > 0 ? `${sender} (${senderName})` : sender;
  return [
    "Extract the transaction details from the following SMS.",
    `Use the date context (${DATE_CONTEXT_ISO}) for any incomplete timestamps.`,
    "If the SMS does not contain a confirmed debit or credit transaction, respond strictly with null.",
    "Otherwise, return a single JSON object using the required schema.",
    "",
    "Message:",
    body,
    "",
    "Sender:",
    senderLabel,
    "",
    `Treat the current date as ${DATE_CONTEXT_LABEL}.`,
  ].join("\n");
}

function sanitizeExtraction(extraction: DevExtraction): DevExtraction {
  const currency = extraction.currency.toUpperCase();
  const targetParty = extraction.targetParty.trim();
  const description = extraction.description.trim();
  const category = extraction.category.trim();

  return {
    amount: extraction.amount,
    type: extraction.type,
    targetParty,
    currency,
    medium: extraction.medium,
    category,
    description,
    date_of_transaction: normalizeIsoTimestamp(extraction.date_of_transaction),
  };
}

function normalizeIsoTimestamp(value: string): string {
  const trimmed = value.trim();
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return trimmed;
  }

  const date = new Date(parsed);
  return date.toISOString();
}
