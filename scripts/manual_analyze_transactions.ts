#!/usr/bin/env tsx

/**
 * Manual runner: analyze transactions for owner=2 but limit insights to 5-10
 * Usage:
 *  npx tsx scripts/manual_analyze_transactions.ts --max 10
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const repoDotenv = join(process.cwd(), '.env');
if (!process.env.DATABASE_URL && existsSync(repoDotenv)) {
  try {
    const dotenv = await import('dotenv');
    // `dotenv` may export a default or a named `config` function depending on installation
    const cfg: any = dotenv?.config ?? (dotenv as any).default?.config ?? (dotenv as any).config;
    if (typeof cfg === 'function') cfg({ path: repoDotenv });
    // eslint-disable-next-line no-console
    console.log('Loaded .env (manual) from', repoDotenv);
  } catch (e) {
    try {
      const content = require('fs').readFileSync(repoDotenv, 'utf8');
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
  const argv = process.argv.slice(2);
  const maxArgIndex = argv.findIndex(a => a === '--max');
  const max = maxArgIndex >= 0 && argv.length > maxArgIndex + 1 ? Number(argv[maxArgIndex + 1]) : 10;

  console.log('Running manual analyst (owner=2) with maxInsights=', max);
  try {
    const mod = await import('../web/src/runtime/param/analyst-agent');
    const result = await mod.runAnalyst({ ownerId: 2, reanalyzeAll: true, maxInsights: max });
    console.log('Analyst result summary:');
    console.log(JSON.stringify({ status: result.status, total: result.totalTransactions, analyzed: result.analyzedTransactions, insightsGenerated: result.insightsGenerated, message: result.message }, null, 2));
  } catch (err) {
    console.error('manual run failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
