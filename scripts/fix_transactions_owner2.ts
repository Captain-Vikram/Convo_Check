#!/usr/bin/env tsx

/**
 * Inspect transactions for owner=2 and propose/apply safe fixes to make them
 * readable by the analyst pipeline.
 *
 * Usage:
 *  - Preview only: npx tsx scripts/fix_transactions_owner2.ts
 *  - Apply fixes:   npx tsx scripts/fix_transactions_owner2.ts --apply
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

type TxRow = any;

function isFiniteNumber(v: any) { return typeof v === 'number' && Number.isFinite(v); }

async function main() {
  const { prisma } = await import('../web/src/lib/prisma');
  const ownerId = 2;

  console.log('Fetching latest 200 transactions for owner=', ownerId);
  const rows: TxRow[] = await prisma.tranasctions.findMany({
    where: { owner: ownerId },
    orderBy: { date_created: 'desc' },
    take: 200,
  });

  if (!rows || rows.length === 0) {
    console.log('No transactions found for owner', ownerId);
    process.exit(0);
  }

  const proposals: { id: any; fixes: Record<string, any>; reasons: string[] }[] = [];

  for (const r of rows) {
    const fixes: Record<string, any> = {};
    const reasons: string[] = [];

    if (!r.status || r.status !== 'Active') {
      reasons.push(`status=${String(r.status)}`);
      fixes.status = 'Active';
    }

    if (!isFiniteNumber(r.amount)) {
      // try to parse amount from strings in description/original_sms
      const maybe = parseAmountFromText(r.original_sms ?? r.description ?? '');
      if (maybe !== null) {
        fixes.amount = maybe;
        reasons.push('amount parsed from text');
      } else {
        reasons.push('invalid amount');
      }
    }

    // Ensure date_created exists and is a valid date
    const dateCreatedOK = r.date_created && !Number.isNaN(new Date(r.date_created).getTime());
    const dateOfTxOK = r.date_of_transaction && !Number.isNaN(new Date(r.date_of_transaction).getTime());

    if (!dateCreatedOK && dateOfTxOK) {
      fixes.date_created = new Date(r.date_of_transaction);
      reasons.push('filled date_created from date_of_transaction');
    }

    if (!dateOfTxOK && dateCreatedOK) {
      fixes.date_of_transaction = new Date(r.date_created);
      reasons.push('filled date_of_transaction from date_created');
    }

    if (!r.currency) {
      fixes.currency = 'INR';
      reasons.push('defaulted currency to INR');
    }

    if (!r.category) {
      fixes.category = 'Uncategorized';
      reasons.push('defaulted category');
    }

    // If analyzed_at is set, and user likely wants to analyze again, clear it only in apply mode when --apply-clear-analyzed is provided
    if (r.analyzed_at) {
      // don't clear automatically; just report
      reasons.push('already analyzed (analyzed_at present)');
    }

    if (Object.keys(fixes).length > 0 || reasons.length > 0) {
      proposals.push({ id: r.id, fixes, reasons });
    }
  }

  console.log(`Found ${proposals.length} transactions with issues/proposals.`);

  for (const p of proposals) {
    console.log('---');
    console.log('id:', p.id);
    console.log('reasons:', p.reasons.join('; '));
    if (Object.keys(p.fixes).length > 0) console.log('proposed fixes:', p.fixes);
  }

  if (APPLY) {
    console.log('\nApplying fixes...');
    for (const p of proposals) {
      if (!p.fixes || Object.keys(p.fixes).length === 0) continue;
      try {
        await prisma.tranasctions.update({ where: { id: p.id }, data: p.fixes });
        console.log('Updated', p.id);
      } catch (err) {
        console.error('Failed to update', p.id, err);
      }
    }
    console.log('Apply complete.');
  } else {
    console.log('\nPreview mode (no changes applied). To apply fixes run with --apply');
  }

  process.exit(0);
}

function parseAmountFromText(text: string): number | null {
  if (!text) return null;
  // find first occurrence of a number-like token with optional commas and decimals
  const m = text.match(/([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const cleaned = m[1].replace(/,/g, '');
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : null;
}

main().catch(err => { console.error(err); process.exit(1); });
