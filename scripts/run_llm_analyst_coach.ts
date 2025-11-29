#!/usr/bin/env tsx

/**
 * Runner to execute model-backed analyst + coach flows for owner=2.
 * Persists insights and coach briefing using the app's normal code paths.
 * Run with: npx tsx scripts/run_llm_analyst_coach.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Load .env if present
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
  // Import the app code that exposes the analyst and coach functions
  const analystMod = await import('../web/src/runtime/param/analyst-agent');
  const coachMod = await import('../web/src/runtime/chatur/coach-agent');

  const ownerId = 2;

  console.log('Running runAnalyst for owner=', ownerId, ' (this will call LLM)');
  try {
    const analystResult = await analystMod.runAnalyst({ ownerId, reanalyzeAll: true });
    console.log('Analyst result:', {
      status: analystResult.status,
      total: analystResult.totalTransactions,
      analyzed: analystResult.analyzedTransactions,
      insightsGenerated: analystResult.insightsGenerated,
      message: analystResult.message,
    });

    if (analystResult.status !== 'success') {
      console.warn('Analyst did not succeed — aborting coach run.');
      process.exit(1);
    }
  } catch (err) {
    console.error('runAnalyst failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  console.log('\nRunning runCoach for owner=', ownerId, ' (this will call LLM)');
  try {
    const briefing = await coachMod.runCoach({ ownerId, forceRefresh: true });
    if (!briefing) {
      console.warn('runCoach returned null (no briefing).');
      process.exit(1);
    }

    console.log('\nPersisted coach briefing:');
    console.log('Headline:', briefing.headline);
    console.log('\nEvidence:', briefing.evidence);
    console.log('\nCounsel:', briefing.counsel);
    console.log('\nBriefing ID:', briefing.id);
  } catch (err) {
    console.error('runCoach failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
