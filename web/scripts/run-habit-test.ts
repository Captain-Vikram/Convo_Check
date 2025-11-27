import 'dotenv/config';

import { loadTransactions } from "../src/runtime/param/transactions-loader";
import { analyzeTransactionHabit } from "../src/runtime/param/habit-tracker";

async function main() {
  const ownerId = process.env.DEV_USER_ID ? Number(process.env.DEV_USER_ID) : 1;
  console.log(`Running habit test for owner=${ownerId}`);

  const normalized = await loadTransactions({ ownerId });
  if (!normalized || normalized.length === 0) {
    console.log('No transactions found for owner', ownerId);
    process.exit(0);
  }

  // Take the latest 5 transactions
  const latest = normalized.slice(-5);
  console.log(`Found ${normalized.length} transactions, analyzing latest ${latest.length}`);

  for (const tx of latest) {
    const transaction = {
      ownerPhone: "",
      transactionId: tx.id || "",
      datetime: tx.recordedAt,
      date: tx.eventDate || (tx.recordedAt ? tx.recordedAt.split('T')[0] : ''),
      time: tx.eventTime || '00:00:00',
      amount: tx.amount,
      currency: tx.currency || 'INR',
      type: tx.direction === 'income' ? 'credit' : 'debit',
      targetParty: tx.meta?.targetParty || '',
      description: tx.description || '',
      category: tx.category || 'uncategorized',
      isFinancial: true,
      medium: tx.meta?.medium || '',
    } as any;

    try {
      const result = await analyzeTransactionHabit(transaction, { ownerId, lookbackCount: 5 });
      console.log(`Processed transaction ${transaction.transactionId} -> habit ${result.habitEntry.habitId}`);
    } catch (err) {
      console.error('Failed to analyze transaction', transaction.transactionId, err);
    }
  }

  console.log('Done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
