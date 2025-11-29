#!/usr/bin/env tsx
/*
  Chatur API-based Test Runner

  Calls the HTTP API routes instead of importing server modules.
  Run with:
    npx tsx scripts/chatur_api_runner.ts

  Environment:
    BASE_URL - default http://localhost:3000
    DEV_AUTH_TOKEN - Bearer token for Authorization header (optional)
    CRON_SECRET - secret for /api/chatur/daily if required
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const DEV_TOKEN = process.env.DEV_AUTH_TOKEN || 'test-token-123';
const CRON_SECRET = process.env.CRON_SECRET || '';

const OUT_DIR = path.join(process.cwd(), 'tests', 'chatur_responses');
fs.mkdirSync(OUT_DIR, { recursive: true });

function nowName(suffix = '') {
  const t = new Date().toISOString().replace(/[:.]/g, '-');
  return `${t}${suffix ? '-' + suffix : ''}`;
}

async function save(name: string, data: unknown) {
  const filename = path.join(OUT_DIR, `${nowName(name)}.json`);
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  console.log('Saved ->', filename);
}

function headers() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${DEV_TOKEN}`,
  };
}

async function postAgent(userId: string, message: string) {
  const url = `${BASE_URL}/api/agent`;
  const body = { userId, message };
  const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { status: res.status, text }; }
}

async function callDaily(ownerId = 1) {
  const url = new URL(`${BASE_URL}/api/chatur/daily`);
  if (CRON_SECRET) url.searchParams.set('secret', CRON_SECRET);
  url.searchParams.set('ownerId', String(ownerId));
  const res = await fetch(url.toString(), { method: 'GET', headers: headers() });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { status: res.status, text }; }
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log('Chatur API runner - BASE_URL=', BASE_URL);

  // Scenario 1: batch fresh run (ownerId = 2)
  console.log('\n-- Scenario 1: batch fresh run (daily API) for owner=2');
  const daily = await callDaily(2);
  await save('api_batch_no_question', daily);

  // Scenario 2: Exact question via agent API (cache hit test)
  console.log('\n-- Scenario 2: exact question (agent API)');
  // Use fixed user id '2' for agent calls so tests target owner/user 2
  const userId = '2';
  const q = 'Should I buy a ₹15,000 phone?';
  const r1 = await postAgent(userId, q);
  await save('api_batch_question_first', r1);
  await sleep(1000);
  const r2 = await postAgent(userId, q);
  await save('api_batch_question_cache_hit', r2);

  // Scenario 3: Similar question
  console.log('\n-- Scenario 3: similar question');
  const r3 = await postAgent('2', 'Is a ₹15k smartphone worth it?');
  await save('api_batch_similar_question', r3);

  // Scenario 4: stale data -> call daily again after you manually mark stale via Studio if needed
  console.log('\n-- Scenario 4: stale refresh (invoke daily API)');
  const r4 = await callDaily(2);
  await save('api_batch_stale_refresh', r4);

  // Scenario 5: conversational start + continue via agent API
  console.log('\n-- Scenario 5: conversational start + continue');
  const convUser = '2';
  const s1 = await postAgent(convUser, 'Advise on saving money.');
  await save('api_convo_start', s1);
  await sleep(1500);
  const s2 = await postAgent(convUser, 'What about investments?');
  await save('api_convo_continue', s2);

  // Scenario 6: escalation to Mill
  console.log('\n-- Scenario 6: escalation to Mill');
  const escUser = '2';
  const e1 = await postAgent(escUser, 'I want to log a transaction.');
  await save('api_escalation_prompt', e1);
  await sleep(500);
  const e2 = await postAgent(escUser, 'Log my ₹100 coffee spend.');
  await save('api_escalation', e2);

  // Scenario 7: Error/fallback - cannot easily force server-side LLM via API without changing server,
  // so we call a known-bad message to observe behavior (or run the mocked script locally).
  console.log('\n-- Scenario 7: error/fallback via API (best-effort)');
  const bad = await postAgent('2', 'This message should test fallback behavior if LLM fails');
  await save('api_error_fallback', bad);

  // Scenario 8: rate limit - call daily multiple times quickly
  console.log('\n-- Scenario 8: rate limit (daily API)');
  const rr1 = await callDaily(2);
  await save('api_rate_run1', rr1);
  const rr2 = await callDaily(2);
  await save('api_rate_run2', rr2);
  const rr3 = await callDaily(2);
  await save('api_rate_run3', rr3);

  console.log('\nAPI-runner complete. Saved responses to tests/chatur_responses/');
}

main().catch((err) => { console.error('Runner failed:', err); process.exit(1); });
