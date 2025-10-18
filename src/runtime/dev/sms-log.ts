import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import type { DevPipelineResult } from "./dev-agent.js";
import type { SmsMessage } from "./dev-sms-agent.js";
import type { NormalizedTransaction } from "./transaction-normalizer.js";

export interface SmsLogOptions {
  baseDir?: string;
  fileName?: string;
}

export interface SmsLog {
  filePath: string;
  record(message: SmsMessage, result: DevPipelineResult): Promise<void>;
}

const LOG_HEADER = [
  "fingerprint",
  "received_at",
  "sender",
  "message",
  "timestamp",
  "date",
  "time",
  "category",
  "score",
  "is_financial",
  "amount",
  "currency",
  "type",
  "medium",
  "target_party",
  "description",
  "extracted_date",
  "transaction_id",
  "normalized_recorded_at",
  "normalized_event_date",
  "normalized_event_time",
  "normalized_amount",
  "normalized_currency",
  "normalized_direction",
  "normalized_category",
  "normalized_flavor",
  "normalized_description",
  "normalized_summary",
  "normalized_tags",
  "normalized_heuristics",
].join(",");

export async function createSmsLog(options: SmsLogOptions = {}): Promise<SmsLog> {
  const baseDir = options.baseDir ?? join(process.cwd(), "data");
  const fileName = options.fileName ?? "sms-ingest-log.csv";
  const filePath = join(baseDir, fileName);
  const knownFingerprints = new Set<string>();
  let initialized = false;

  async function ensureReady() {
    if (initialized) {
      return;
    }

    await ensureLogFile(filePath);
    await seedFingerprints(filePath, knownFingerprints);
    initialized = true;
  }

  async function record(message: SmsMessage, result: DevPipelineResult): Promise<void> {
    if (result.status !== "logged") {
      return;
    }

    const normalized = result.normalized;

    await ensureReady();

    const fingerprint = buildFingerprint(message);
    if (knownFingerprints.has(fingerprint)) {
      return;
    }

    knownFingerprints.add(fingerprint);
    const row = serializeCsvRow([
      fingerprint,
      new Date().toISOString(),
      message.sender,
      message.message,
      message.timestamp ?? "",
      message.date ?? "",
      message.time ?? "",
      message.category ?? "",
      message.score ?? "",
      message.is_financial ?? "",
      message.amount ?? "",
      message.currency ?? "",
      message.type ?? "",
      resolveMedium(message, normalized),
      resolveTargetParty(message, normalized),
      message.description ?? "",
      message.extractedDate ?? "",
      normalized.id,
      normalized.recordedAt,
      normalized.eventDate,
      normalized.eventTime ?? "",
      normalized.amount,
      normalized.currency,
      normalized.direction,
      normalized.category,
      normalized.flavor,
      normalized.description,
      normalized.structuredSummary,
      normalized.tags.join("|"),
      normalized.meta.heuristics.join("|"),
    ]);

    await appendFile(filePath, `${row}\n`, "utf8");
  }

  return {
    filePath,
    record,
  };
}

function resolveMedium(message: SmsMessage, normalized: NormalizedTransaction): string {
  const medium = normalized.meta.medium;
  if (medium && medium.length > 0) {
    return medium;
  }

  return message.medium ?? "";
}

function resolveTargetParty(message: SmsMessage, normalized: NormalizedTransaction): string {
  const target = normalized.meta.targetParty;
  if (target && target.length > 0) {
    return target;
  }

  return message.targetParty ?? "";
}

async function ensureLogFile(filePath: string): Promise<void> {
  try {
    await access(filePath, constants.F_OK);
  } catch {
    await ensureParentDirectory(filePath);
    await writeFile(filePath, `${LOG_HEADER}\n`, "utf8");
  }
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
}

async function seedFingerprints(filePath: string, target: Set<string>): Promise<void> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    for (let index = 1; index < lines.length; index += 1) {
      const rawLine = lines[index];
      if (!rawLine || rawLine.trim().length === 0) {
        continue;
      }

      const values = parseCsvLine(rawLine);
      if (values.length === 0) {
        continue;
      }

      const [fingerprint] = values;
      if (fingerprint && fingerprint.length > 0) {
        target.add(fingerprint);
      }
    }
  } catch (error) {
    console.error("[sms-log] Failed to seed log cache", error);
  }
}

function buildFingerprint(message: SmsMessage): string {
  const hash = createHash("sha256");
  hash.update(message.sender);
  hash.update("|");
  hash.update(message.message);

  if (message.timestamp) {
    hash.update("|ts:");
    hash.update(message.timestamp);
  }

  if (message.date) {
    hash.update("|date:");
    hash.update(message.date);
  }

  if (message.time) {
    hash.update("|time:");
    hash.update(message.time);
  }

  return hash.digest("hex");
}

function serializeCsvRow(values: Array<string | number | undefined | null>): string {
  return values
    .map((value) => {
      const stringValue = value === undefined || value === null ? "" : String(value);
      const escaped = stringValue.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(",");
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  const sanitized = line.replace(/\r$/, "");

  for (let index = 0; index < sanitized.length; index += 1) {
    const char = sanitized[index];

    if (char === '"') {
      const nextChar = sanitized[index + 1];
      if (inQuotes && nextChar === '"') {
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
  return values.map((value) => value.trim());
}
