#!/usr/bin/env tsx
/*
  Chatur E2E Test Scenarios

  Run with:
    npx tsx scripts/chatur_scenarios.ts

  Requires: repo root, dev DB available to Prisma client used in the app.
*/
import fs from 'fs';
import path from 'path';

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

async function scenario1() {
  console.log('\n== Scenario 1: Batch fresh run (no question) ==');
  const mod = await import('../web/src/runtime/chatur/coach-agent');
  const res = await mod.runCoach({ ownerId: 2, forceRefresh: true });
  await save('batch_no_question', res);
}

async function scenario2() {
  console.log('\n== Scenario 2: Exact question (cache hit) ==');
  const mod = await import('../web/src/runtime/chatur/coach-agent');
  const q = 'Should I buy a ₹15,000 phone?';
  const first = await mod.runCoach({ ownerId: 2, question: q });
  await save('batch_question_first', first);
  const second = await mod.runCoach({ ownerId: 2, question: q });
  await save('batch_question_cache_hit', second);
}

async function scenario3() {
  console.log('\n== Scenario 3: Similar question (similarity) ==');
  const mod = await import('../web/src/runtime/chatur/coach-agent');
  const q = 'Is a ₹15k smartphone worth it?';
  const res = await mod.runCoach({ ownerId: 2, question: q });
  await save('batch_similar_question', res);
}

async function scenario4() {
  console.log('\n== Scenario 4: Stale data triggers Param refresh ==');
  // Make habit_insights stale via Prisma then run
  try {
    const prismaMod = await import('../web/src/lib/prisma');
    const prisma = prismaMod.prisma;
    // Update recent habit_insights for owner=2 to an old date
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    // Pass a Date object so the DB parameter is a proper timestamp/timestamptz
    await prisma.$executeRaw`UPDATE habit_insights SET recorded_at = ${tenDaysAgo} WHERE owner = 2`;
    console.log('Marked habit_insights owner=2 as stale (10 days ago)');
  } catch (err) {
    console.warn('Could not mark stale via Prisma (continue):', err?.message ?? err);
  }
  const mod = await import('../web/src/runtime/chatur/coach-agent');
  const res = await mod.runCoach({ ownerId: 2 });
  await save('batch_stale_refresh', res);
}

async function scenario5() {
  console.log('\n== Scenario 5: Conversational start + continue ==');
  const mod = await import('../web/src/runtime/chatur/conversational-coach');
  const coach = new mod.ConversationalCoach();
  const session = coach.startConversation({ insights: [], initialQuestion: 'Advise on saving money.' });
  console.log('Started session', session.sessionId);
  const res = await coach.continueConversation(session.sessionId, 'What about investments?');
  await save('convo_session', { session, response: res });
}

async function scenario6() {
  console.log('\n== Scenario 6: Escalation to Mill ==');
  const mod = await import('../web/src/runtime/chatur/conversational-coach');
  const coach = new mod.ConversationalCoach();
  const session = coach.startConversation({ insights: [], initialQuestion: 'I want to log a transaction.' });
  const res = await coach.continueConversation(session.sessionId, 'Log my ₹100 coffee spend.');
  await save('convo_escalation', { sessionId: session.sessionId, response: res });
}

async function scenario7() {
  console.log('\n== Scenario 7: Error/Retry (mock bad LLM) ==');
  // Use an environment hook to force an invalid LLM response for testing.
  process.env.MOCK_BAD_LLM = '1';
  try {
    const mod = await import('../web/src/runtime/chatur/coach-agent');
    const res = await mod.runCoach({ ownerId: 1, question: 'Is this a test for fallback?' });
    await save('error_fallback', res);
  } finally {
    delete process.env.MOCK_BAD_LLM;
  }
}

async function scenario8() {
  console.log('\n== Scenario 8: Rate limit test ==');
  process.env.CHATUR_MAX_RUNS_PER_DAY = '2';
  const mod = await import('../web/src/runtime/chatur/coach-agent');
  const r1 = await mod.runCoach({ ownerId: 2 });
  await save('rate_run1', r1);
  const r2 = await mod.runCoach({ ownerId: 2 });
  await save('rate_run2', r2);
  const r3 = await mod.runCoach({ ownerId: 2 });
  await save('rate_run3', r3);
}

async function main() {
  console.log('Chatur scenarios runner');
  try {
    await scenario1();
    await scenario2();
    await scenario3();
    await scenario4();
    await scenario5();
    await scenario6();
    await scenario7();
    await scenario8();
    console.log('\nAll scenarios complete.');
  } catch (err) {
    console.error('Runner failed:', err);
  }
}

main();
