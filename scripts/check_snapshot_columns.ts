#!/usr/bin/env tsx

// Script to list columns on habit_insights using Prisma
// Run: npx tsx scripts/check_snapshot_columns.ts

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Auto-load .env if present (matches other scripts)
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
  const { prisma } = await import('../web/src/lib/prisma.js');

  try {
    const rows: Array<{ column_name: string }> = await prisma.$queryRaw`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'habit_insights'
      ORDER BY ordinal_position
    ` as any;

    console.log('Columns on habit_insights:');
    for (const r of rows) {
      console.log(' -', r.column_name);
    }
  } catch (err) {
    console.error('Query failed:', err && (err as any).message ? (err as any).message : err);
  } finally {
    try { await (await import('../web/src/lib/prisma.js')).prisma.$disconnect(); } catch (e) {}
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
