import { logger } from "../shared/logger";
import type { NormalizedTransaction } from "../dev/transaction-normalizer";
import { prisma } from "@/lib/prisma";

export interface LoadTransactionsOptions {
  filePath?: string;
}

export async function loadTransactions(
  options: LoadTransactionsOptions = {},
): Promise<NormalizedTransaction[]> {
  void options;

  try {
    const records = await prisma.tranasctions.findMany({
      where: { status: "Active" },
      orderBy: { date_created: 'desc' },
    });
    
    // Map DB records to NormalizedTransaction format
    return records.map(record => {
      // Map debit/credit to expense/income for Analyst compatibility
      let direction: NormalizedTransaction["direction"] = "expense";
      if (record.type === "credit" || record.type === "income") {
        direction = "income";
      } else {
        direction = "expense";
      }

      return {
        id: record.id.toString(),
        direction,
        amount: record.amount || 0,
      currency: record.currency || "INR",
      category: record.category || "uncategorized",
      flavor: "regular" as NormalizedTransaction["flavor"], // Not in DB schema
      description: record.description || "",
      rawText: String(record.original_sms || record.description || ""),
      recordedAt: record.date_created?.toISOString() || new Date().toISOString(),
      eventDate: record.date_of_transaction 
        ? (typeof record.date_of_transaction === 'string' ? record.date_of_transaction : record.date_of_transaction.toISOString().split('T')[0])
        : record.date_created?.toISOString().split('T')[0] || new Date().toISOString().split('T')[0],
      eventTime: undefined, // Not in DB schema
      targetParty: record.target_party || undefined,
      tags: [], // Not in DB schema
      structuredSummary: record.description || "",
      meta: {
        source: "database",
        heuristics: [],
        analyzedAt: record.analyzed_at?.toISOString(),
        analyzedVersion: record.analyzed_version || undefined,
        medium: record.medium || undefined,
        targetParty: record.target_party || undefined,
      },
    };
    });
  } catch (error) {
    logger.error("transactions-loader", "Failed to fetch transactions from DB", error);
    return [];
  }
}
