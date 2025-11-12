import { callLLM } from "../shared/llm-client.js";
import { z } from "zod";

import { devAgent } from "../../agents/dev.js";
import type { SmsMessage } from "./dev-sms-agent.js";
import { PIIMasker } from "../shared/pii-masker.js";
import { createLLMCircuitBreaker } from "../shared/circuit-breaker.js";
import { extractWithRegex } from "./sms-regex-extractor.js";
import { parserLogger } from "../shared/logger.js";

// Create circuit breaker for LLM extraction
const extractionCircuitBreaker = createLLMCircuitBreaker("dev-llm-parser");

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

/**
 * Batch extract transactions from multiple SMS messages (5-8x faster than individual calls)
 * Processes up to 10 messages per LLM call for optimal token usage
 */
export async function extractTransactionBatch(
  messages: SmsMessage[],
  batchSize: number = 10,
): Promise<Map<string, DevExtraction[]>> {
  const results = new Map<string, DevExtraction[]>();
  
  // Process in batches
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    
    try {
      const batchResults = await extractionCircuitBreaker.execute(
        async () => extractBatchWithLLM(batch),
        () => {
          // Fallback: extract individually with regex
          const fallbackResults = new Map<string, DevExtraction[]>();
          for (const msg of batch) {
            const timestampMs = msg.timestamp ? Date.parse(msg.timestamp) : undefined;
            const regexResult = extractWithRegex(msg.message, timestampMs);
            const messageKey = `${msg.sender}-${msg.timestamp || Date.now()}`;
            fallbackResults.set(messageKey, regexResult ? [regexResult] : []);
          }
          return fallbackResults;
        }
      );
      
      // Merge batch results into overall results
      for (const [key, extractions] of batchResults) {
        results.set(key, extractions);
      }
    } catch (error) {
      parserLogger.error("Batch extraction failed", error, {
        batchSize: batch.length,
        batchIndex: Math.floor(i / batchSize),
      });
      
      // Fall back to regex for failed batch
      for (const msg of batch) {
        const timestampMs = msg.timestamp ? Date.parse(msg.timestamp) : undefined;
        const regexResult = extractWithRegex(msg.message, timestampMs);
        const messageKey = `${msg.sender}-${msg.timestamp || Date.now()}`;
        results.set(messageKey, regexResult ? [regexResult] : []);
      }
    }
  }
  
  return results;
}

/**
 * Extract one or more transactions from an SMS message.
 * Supports multi-transaction messages by returning an array.
 * Uses circuit breaker with regex fallback for resilience.
 * Returns empty array if no transactions found.
 */
export async function extractTransactionFromSms(
  message: SmsMessage,
): Promise<DevExtraction[]> {
  try {
    // Use circuit breaker with regex fallback
    return await extractionCircuitBreaker.execute(
      async () => extractWithLLM(message),
      () => {
        // Fallback to regex extraction
        const timestampMs = message.timestamp ? Date.parse(message.timestamp) : undefined;
        const regexResult = extractWithRegex(message.message, timestampMs);
        return regexResult ? [regexResult] : [];
      }
    );
  } catch (error) {
    parserLogger.error("Failed to extract transaction", error, {
      sender: PIIMasker.maskPhone(message.sender || ''),
      senderName: message.senderName,
    });
    return [];
  }
}

/**
 * Extract transaction using LLM (primary method)
 */
async function extractWithLLM(message: SmsMessage): Promise<DevExtraction[]> {
  const prompt = buildPrompt(message);
  
  const result = await callLLM("agent2", {
    messages: [
      { role: "system", content: devAgent.systemPrompt },
      { role: "user", content: prompt },
    ],
  });

  const raw = (result.text ?? "").trim();

  if (raw.length === 0) {
    return [];
  }

  const jsonCandidates = normalizeJsonPayload(raw);

  if (!jsonCandidates || jsonCandidates.length === 0) {
    return [];
  }

  const extractions: DevExtraction[] = [];

  for (const candidate of jsonCandidates) {
    if (candidate === "null") {
      continue;
    }

    try {
      const parsed = JSON.parse(candidate) as unknown;
      const validation = extractionSchema.safeParse(parsed);

      if (validation.success) {
        extractions.push(sanitizeExtraction(validation.data));
      } else {
        parserLogger.warn("Extraction schema mismatch for one transaction", validation.error.flatten());
      }
    } catch (parseError) {
      parserLogger.warn("Failed to parse JSON candidate", { candidate, parseError });
    }
  }

  return extractions;
}

/**
 * Extract transactions from batch of messages using LLM
 */
async function extractBatchWithLLM(messages: SmsMessage[]): Promise<Map<string, DevExtraction[]>> {
  const results = new Map<string, DevExtraction[]>();
  
  // Build batch prompt
  const batchPrompt = buildBatchPrompt(messages);
  
  const result = await callLLM("agent2", {
    messages: [
      { role: "system", content: devAgent.systemPrompt },
      { role: "user", content: batchPrompt },
    ],
  });

  const raw = (result.text ?? "").trim();

  if (raw.length === 0) {
    return results;
  }

  // Parse batch response - expect array of { messageIndex, extractions }
  try {
    const batchSchema = z.array(z.object({
      messageIndex: z.number(),
      extractions: z.array(extractionSchema),
    }));
    
    const jsonCandidates = normalizeJsonPayload(raw);
    if (!jsonCandidates || jsonCandidates.length === 0) {
      return results;
    }

    for (const candidate of jsonCandidates) {
      if (candidate === "null") continue;
      
      try {
        const parsed = JSON.parse(candidate);
        const validation = batchSchema.safeParse(parsed);
        
        if (validation.success) {
          for (const item of validation.data) {
            if (item.messageIndex >= 0 && item.messageIndex < messages.length) {
              const msg = messages[item.messageIndex];
              if (msg) {
                const messageKey = `${msg.sender}-${msg.timestamp || Date.now()}`;
                results.set(messageKey, item.extractions.map(sanitizeExtraction));
              }
            }
          }
        }
      } catch (parseError) {
        parserLogger.warn("Failed to parse batch response candidate", { candidate, parseError });
      }
    }
  } catch (error) {
    parserLogger.error("Batch extraction parsing failed", error);
  }

  return results;
}

/**
 * Build prompt for batch extraction
 */
function buildBatchPrompt(messages: SmsMessage[]): string {
  const messageList = messages.map((msg, idx) => {
    const dateContext = msg.timestamp 
      ? `Date context: ${new Date(msg.timestamp).toISOString()}`
      : `Date context: ${new Date().toISOString()}`;
    
    return `Message ${idx}:
Sender: ${msg.sender}
${dateContext}
Content: ${msg.message}
---`;
  }).join('\n');

  return `Extract financial transactions from these ${messages.length} SMS messages.
For each message that contains a transaction, return its index and extracted data.

${messageList}

Return JSON array format:
[
  {
    "messageIndex": 0,
    "extractions": [{ amount, type, targetParty, currency, medium, category, description, date_of_transaction }]
  },
  ...
]

If a message has no transaction, omit its entry. If a message has multiple transactions, include all in the extractions array.`;
}

/**
 * Extract all JSON objects from LLM response.
 * Handles arrays, single objects, fenced blocks, and multiple {...} blocks.
 */
function normalizeJsonPayload(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const lower = trimmed.toLowerCase();
  if (lower === "null") {
    return ["null"];
  }

  // Try parsing as array first
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(obj => JSON.stringify(obj));
      }
    } catch {
      // Continue to other extraction methods
    }
  }

  // Try parsing as single object
  if (trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed); // Validate
      return [trimmed];
    } catch {
      // Continue to other extraction methods
    }
  }

  // Extract from fenced code block
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedMatch) {
    const content = fencedMatch[1]?.trim() ?? "";
    if (content.startsWith("[") || content.startsWith("{")) {
      return normalizeJsonPayload(content); // Recursive
    }
  }

  // Extract multiple {...} blocks using balanced brace matching
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth++;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const substr = trimmed.slice(start, i + 1);
        try {
          JSON.parse(substr); // Validate
          objects.push(substr);
        } catch {
          // Skip malformed JSON
        }
        start = -1;
      }
    }
  }

  return objects.length > 0 ? objects : [];
}

function buildPrompt(message: SmsMessage): string {
  const body = message.message ?? "";
  const sender = message.sender ?? "";
  const senderName = message.senderName?.trim();
  const senderLabel = senderName && senderName.length > 0 ? `${sender} (${senderName})` : sender;
  
  // Use message timestamp or current date for context
  const messageDate = resolveDateContext(message);
  const dateContextLabel = messageDate.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  const dateContextISO = messageDate.toISOString().split('T')[0];
  
  return [
    "Extract ALL transaction details from the following SMS.",
    `Use the date context (${dateContextISO}) for any incomplete timestamps.`,
    "If the SMS contains NO confirmed debit or credit transactions, respond strictly with null.",
    "If the SMS contains ONE transaction, return a single JSON object using the required schema.",
    "If the SMS contains MULTIPLE transactions, return a JSON array of objects: [{...}, {...}].",
    "",
    "Message:",
    body,
    "",
    "Sender:",
    senderLabel,
    "",
    `Treat the current date as ${dateContextLabel}.`,
  ].join("\n");
}

/**
 * Resolve the date context from message metadata or current date.
 */
function resolveDateContext(message: SmsMessage): Date {
  // Try multiple timestamp fields from SMS export
  const timestampCandidates = [
    message.timestamp,
    message.datetime_readable,
    message.date,
  ];

  for (const candidate of timestampCandidates) {
    if (candidate) {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) {
        return new Date(parsed);
      }
    }
  }

  // Fallback to current date
  return new Date();
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
