#!/usr/bin/env tsx

/**
 * List transactions for owner=2 and evaluate whether each is analyzable.
 * Run with: npx tsx scripts/list_transactions_owner.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Auto-load repository .env if DATABASE_URL is not already set in the environment.
const repoDotenv = join(process.cwd(), '.env');
if (!process.env.DATABASE_URL && existsSync(repoDotenv)) {
  try {
    // Try to use dotenv if available
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dotenv = require('dotenv');
    dotenv.config({ path: repoDotenv });
    // eslint-disable-next-line no-console
    console.log('Loaded env from', repoDotenv);
  } catch (e) {
    // Fallback: manual parse of simple KEY=VALUE lines
    try {
      const content = readFileSync(repoDotenv, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        // strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
      // eslint-disable-next-line no-console
      console.log('Loaded .env (manual) from', repoDotenv);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Failed to load .env file:', err?.message ?? err);
    }
  }
}

async function main() {
  const mod = await import('../web/src/lib/prisma');
  const prisma = mod.prisma;

  const ownerId = 2;
  console.log(`Querying transactions for owner=${ownerId}...`);

  const txs = await prisma.tranasctions.findMany({
    where: { owner: ownerId },
    orderBy: { date_created: 'asc' },
    select: {
      id: true,
      amount: true,
      currency: true,
      category: true,
      type: true,
      target_party: true,
      medium: true,
      description: true,
      comments: true,
      date_created: true,
      date_of_transaction: true,
      analyzed_at: true,
      analyzed_version: true,
      analysis_notes: true,
      status: true,
      original_sms: true,
    },
  });

  if (!txs || txs.length === 0) {
    console.log('No transactions found for owner:', ownerId);
    process.exit(0);
  }

  function isFiniteNumber(v: any) { return typeof v === 'number' && Number.isFinite(v); }

  const results = txs.map((tx, idx) => {
    const reasons: string[] = [];
    if (!isFiniteNumber(tx.amount)) reasons.push('no amount');

    const hasDate = !!tx.date_of_transaction || !!tx.date_created;
    if (!hasDate) reasons.push('no date');

    // Determine if already analyzed
    const analyzed = !!tx.analyzed_at;
    if (analyzed) reasons.push('already analyzed');

    // Heuristic: category might be required for structured analysis
    if (!tx.category) reasons.push('no category');

    const analyzable = reasons.length === 0;

    return {
      index: idx + 1,
      id: tx.id,
      amount: tx.amount,
      currency: tx.currency,
      category: tx.category,
      type: tx.type,
      date_of_transaction: tx.date_of_transaction,
      date_created: tx.date_created,
      analyzed_at: tx.analyzed_at,
      analyzable,
      reasons,
      short: `${tx.id} | amt=${tx.amount ?? 'null'} | date=${tx.date_of_transaction ?? tx.date_created ?? 'null'} | cat=${tx.category ?? 'null'} | analyzed=${tx.analyzed_at ? 'yes' : 'no'}`,
    };
  });

  console.log('Found', results.length, 'transactions. Listing:');
  for (const r of results) {
    console.log(`${r.index}. ${r.short}`);
    if (!r.analyzable) console.log(`   -> Not analyzable: ${r.reasons.join(', ')}`);
  }

  // Summarize
  const analyzableCount = results.filter(r => r.analyzable).length;
  console.log(`\nSummary: ${analyzableCount}/${results.length} analyzable`);

  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
