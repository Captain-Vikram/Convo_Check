/**
 * SMS Export to Optimized CSV Converter
 * 
 * Converts SMS export JSON to the optimized CSV format for Dev agent storage.
 * Only extracts essential financial data fields, reshapes timestamps to ISO format.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface SmsExportOwner {
  name?: string;
  phone?: string;
}

interface SmsMessage {
  sender: string;
  message: string;
  timestamp?: string;
  date?: string;
  time?: string;
  datetime_readable?: string;
  category?: string;
  score?: string;
  is_financial?: string;
  amount?: string;
  currency?: string;
  type?: string;
  medium?: string;
  targetParty?: string;
  description?: string;
  extractedDate?: string;
}

interface SmsExport {
  owner?: SmsExportOwner;
  messages: SmsMessage[];
}

interface OptimizedTransaction {
  ownerPhone: string;
  transactionId: string;
  datetime: string;
  date: string;
  time: string;
  amount: string;
  currency: string;
  type: string;
  targetParty: string;
  description: string;
  category: string;
  isFinancial: string;
  medium: string;
}

/**
 * Converts SMS export JSON to optimized CSV format
 */
export async function convertSmsToOptimized(
  inputPath: string,
  outputPath: string,
): Promise<number> {
  // Read and parse SMS export
  const content = await readFile(inputPath, "utf8");
  const smsExport: SmsExport = JSON.parse(content);

  const ownerPhone = smsExport.owner?.phone || "";
  const transactions: OptimizedTransaction[] = [];

  // Process each message
  for (const msg of smsExport.messages) {
    // Skip non-financial messages
    if (msg.is_financial !== "true") {
      continue;
    }

    // Generate transaction ID from description or timestamp
    const transactionId = msg.description || msg.timestamp || generateId();

    // Reshape datetime to ISO format
    const datetime = msg.datetime_readable
      ? reshapeToIso(msg.datetime_readable)
      : msg.date && msg.time
        ? `${msg.date}T${msg.time}`
        : new Date().toISOString();

    // Extract date and time
    const date = msg.date || datetime.split("T")[0]!;
    const time = msg.time || datetime.split("T")[1]?.split(".")[0] || "00:00:00";

    // Build optimized transaction
    transactions.push({
      ownerPhone,
      transactionId,
      datetime,
      date,
      time,
      amount: msg.amount || "0",
      currency: msg.currency || "",
      type: msg.type || "debit",
      targetParty: msg.targetParty || "",
      description: buildDescription(msg),
      category: msg.category || "Financial - High Confidence",
      isFinancial: "true",
      medium: msg.medium || "",
    });
  }

  // Write to CSV
  await writeOptimizedCsv(outputPath, transactions);

  return transactions.length;
}

/**
 * Reshapes datetime_readable to ISO format
 */
function reshapeToIso(datetimeReadable: string): string {
  // Format: "2025-10-11 20:48:22" -> "2025-10-11T20:48:22"
  return datetimeReadable.replace(" ", "T");
}

/**
 * Builds description from SMS message
 */
function buildDescription(msg: SmsMessage): string {
  // Extract key info without full SMS text
  const parts: string[] = [];

  if (msg.description) {
    parts.push(`Ref:${msg.description}`);
  }

  if (msg.targetParty) {
    const party = msg.targetParty.replace(". Ref", "").trim();
    if (party) {
      parts.push(`to ${party}`);
    }
  }

  // Extract balance if present in message
  const balanceMatch = msg.message?.match(/AvlBal:\s*Rs\s*([\d.]+)/i);
  if (balanceMatch) {
    parts.push(`AvlBal:Rs${balanceMatch[1]}`);
  }

  return parts.join(", ") || msg.message?.substring(0, 100) || "";
}

/**
 * Generates a unique ID
 */
function generateId(): string {
  return `txn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Writes transactions to optimized CSV format
 */
async function writeOptimizedCsv(
  filePath: string,
  transactions: OptimizedTransaction[],
): Promise<void> {
  const header =
    "owner_phone,transaction_id,datetime,date,time,amount,currency,type,target_party,description,category,is_financial,medium";

  const rows = transactions.map((t) =>
    [
      escapeCsv(t.ownerPhone),
      escapeCsv(t.transactionId),
      escapeCsv(t.datetime),
      escapeCsv(t.date),
      escapeCsv(t.time),
      escapeCsv(t.amount),
      escapeCsv(t.currency),
      escapeCsv(t.type),
      escapeCsv(t.targetParty),
      escapeCsv(t.description),
      escapeCsv(t.category),
      escapeCsv(t.isFinancial),
      escapeCsv(t.medium),
    ].join(","),
  );

  const csv = [header, ...rows].join("\n") + "\n";
  await writeFile(filePath, csv, "utf8");
}

/**
 * Escapes CSV field value
 */
function escapeCsv(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const inputPath = process.argv[2] || join(process.cwd(), "sms_export_20251013.json");
  const outputPath = process.argv[3] || join(process.cwd(), "data", "transactions.csv");

  convertSmsToOptimized(inputPath, outputPath)
    .then((count) => {
      console.log(`✅ Converted ${count} transactions to ${outputPath}`);
    })
    .catch((error) => {
      console.error("❌ Conversion failed:", error);
      process.exit(1);
    });
}
