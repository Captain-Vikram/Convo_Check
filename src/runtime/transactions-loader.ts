import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { NormalizedTransaction } from "./transaction-normalizer.js";

export interface LoadTransactionsOptions {
  filePath?: string;
}

export async function loadTransactions(
  options: LoadTransactionsOptions = {},
): Promise<NormalizedTransaction[]> {
  const targetPath = options.filePath ?? join(process.cwd(), "data", "transactions.csv");
  const content = await readFile(targetPath, "utf8");
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return [];
  }

  const header = parseCsvLine(lines[0]!);
  const records: NormalizedTransaction[] = [];

  for (let index = 1; index < lines.length; index += 1) {
  const line = lines[index]!;
  const values = parseCsvLine(line);

    if (values.length === 0) {
      continue;
    }

    const record: Record<string, string> = {};
    header.forEach((key, position) => {
      record[key] = values[position] ?? "";
    });

    try {
      records.push(deserializeRecord(record));
    } catch (error) {
      console.error("[transactions-loader] Failed to parse transaction", {
        error,
        line,
      });
    }
  }

  return records;
}

function deserializeRecord(record: Record<string, string>): NormalizedTransaction {
  const amount = Number.parseFloat(record.amount ?? "0");
  const heuristics = splitList(record.heuristics);
  const tags = splitList(record.tags);

  const normalized: NormalizedTransaction = {
    id: record.transaction_id ?? "",
    recordedAt: record.recorded_at ?? "",
    eventDate: record.event_date ?? "",
    direction: (record.direction ?? "expense") as NormalizedTransaction["direction"],
    amount: Number.isNaN(amount) ? 0 : amount,
    currency: record.currency ?? "",
    category: record.category ?? "",
    flavor: (record.flavor ?? "necessity") as NormalizedTransaction["flavor"],
    description: record.description ?? "",
    rawText: record.raw_text ?? "",
    tags,
    structuredSummary: record.structured_summary ?? "",
    meta: {
      source: record.meta_source ?? "unknown",
      heuristics,
    },
  };

  if (record.event_time && record.event_time.length > 0) {
    normalized.eventTime = record.event_time;
  }

  if (record.raw_category_suggestion && record.raw_category_suggestion.length > 0) {
    normalized.meta.rawCategorySuggestion = record.raw_category_suggestion;
  }

  if (record.parsed_temporal_phrase && record.parsed_temporal_phrase.length > 0) {
    normalized.meta.parsedTemporalPhrase = record.parsed_temporal_phrase;
  }

  if (record.meta_medium && record.meta_medium.length > 0) {
    normalized.meta.medium = record.meta_medium;
  }

  if (record.meta_target_party && record.meta_target_party.length > 0) {
    normalized.meta.targetParty = record.meta_target_party;
  }

  return normalized;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

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
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((entry) => entry.trim());
}

function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split("|")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
