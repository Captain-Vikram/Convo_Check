#!/usr/bin/env tsx

/**
 * Gather latest 25 unanalyzed transactions for a user, generate heuristic habit
 * insights and a coach briefing, persist them to the DB (no external LLM calls).
 *
 * Run: npx tsx scripts/apply_insights_and_briefings.ts
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Auto-load .env if present
const repoDotenv = join(process.cwd(), '.env');
if (!process.env.DATABASE_URL && existsSync(repoDotenv)) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dotenv = require('dotenv');
    dotenv.config({ path: repoDotenv });
    // eslint-disable-next-line no-console
    console.log('Loaded env from', repoDotenv);
  } catch (e) {
    try {
      const content = readFileSync(repoDotenv, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
      // eslint-disable-next-line no-console
      console.log('Loaded .env (manual) from', repoDotenv);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Failed to load .env file:', err && (err as any).message ? (err as any).message : err);
    }
  }
}

async function main() {
  const { prisma } = await import('../web/src/lib/prisma');
  const ownerId = 2;

  console.log('Fetching latest 25 unanalyzed transactions for owner=', ownerId);
  const txs = await prisma.tranasctions.findMany({
    where: { owner: ownerId, status: 'Active', analyzed_at: null },
    orderBy: { date_of_transaction: 'desc' },
    take: 25,
  });

  if (!txs || txs.length === 0) {
    console.log('No unanalyzed transactions found.');
    process.exit(0);
  }

  // Build simple stats
  const categoryTotals = new Map<string, number>();
  let totalExpense = 0;
  for (const t of txs) {
    const amt = typeof t.amount === 'number' ? t.amount : 0;
    const cat = t.category ?? 'Uncategorized';
    categoryTotals.set(cat, (categoryTotals.get(cat) ?? 0) + amt);
    // naive: treat everything as expense for insight generation
    totalExpense += amt;
  }

  const topCategories = Array.from(categoryTotals.entries())
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);

  // Create habit insights for top categories
  const now = new Date();
  const createdHabitIds: string[] = [];
  for (const entry of topCategories) {
    const habitId = randomUUID();
    const habitLabel = `${entry.category} spending`;
    const evidence = `Spent ${Math.round(entry.total)} on ${entry.category} in the latest ${txs.length} transactions.`;
    const counsel = `Consider reviewing ${entry.category} purchases and set a small cap or substitution to reduce this spending.`;
    const fullText = `${evidence} ${counsel}`;

    try {
      await prisma.habit_insights.create({
        data: {
          owner: ownerId,
          habit_id: habitId,
          habit_label: habitLabel,
          evidence,
          counsel,
          full_text: fullText,
          recorded_at: now,
          status: 'draft',
        },
      });
      createdHabitIds.push(habitId);
      console.log('Persisted insight:', habitLabel);
    } catch (err) {
      console.error('Failed to persist habit insight', habitLabel, err);
    }
  }

  // Build coach briefing payload from generated insights
  const headline = `Snapshot: ~${Math.round(totalExpense)} spent across ${txs.length} recent transactions`;
  const evidence = topCategories.map((c, i) => `${i+1}. ${Math.round(c.total)} on ${c.category}`).join('\n');
  const counsel = topCategories.map((c, i) => `${i+1}. Review ${c.category} and set a limit.`).join('\n');

  // Persist briefing
  const insightHash = createHashFromArray(createdHabitIds);
  try {
    const persisted = await prisma.coach_briefings.create({
      data: {
        id: randomUUID(),
        owner: ownerId,
        date_created: new Date(),
        status: 'Active',
        headline,
        counsel,
        evidence,
        insight_hash: insightHash,
        user_question: null,
        agent_answer: JSON.stringify({ headline, counsel, evidence }),
        insights_used: createdHabitIds,
        question_hash: null,
        question_embedding: undefined as any,
      },
      select: { id: true, headline: true, counsel: true, evidence: true },
    });

    console.log('\nPersisted coach briefing:', persisted.headline);
  } catch (err) {
    console.error('Failed to persist coach briefing', err);
  }

  // Mark transactions as analyzed
  try {
    const nowAnalyzedAt = new Date();
    for (const tx of txs) {
      await prisma.tranasctions.update({ where: { id: tx.id }, data: { analyzed_at: nowAnalyzedAt, analyzed_version: 1, analysis_notes: 'Auto-generated insight' } });
    }
    console.log('Marked', txs.length, 'transactions as analyzed.');
  } catch (err) {
    console.error('Failed to mark transactions as analyzed', err);
  }

  console.log('\nDone.');
  process.exit(0);
}

function createHashFromArray(items: string[]): string {
  const { createHash } = require('crypto');
  const h = createHash('sha1');
  for (const it of items) h.update(it + '|');
  return h.digest('hex');
}

main().catch(err => { console.error(err); process.exit(1); });
