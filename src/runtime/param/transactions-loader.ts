import type { NormalizedTransaction } from "../dev/transaction-normalizer.js";
import { fetchTransactionsFromApi } from "../dev/api-sync.js";

export interface LoadTransactionsOptions {
  filePath?: string;
}

export async function loadTransactions(
  options: LoadTransactionsOptions = {},
): Promise<NormalizedTransaction[]> {
  void options; // API-backed loader no longer uses filePath overrides.

  try {
    const records = await fetchTransactionsFromApi();
    return records.sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[transactions-loader] Failed to fetch transactions from API", message);
    return [];
  }
}
