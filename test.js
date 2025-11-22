// ============================================================================
// Convo_Check API Feature Test Suite (Node.js)
// Runs against a local API server
// ============================================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = "http://localhost:3000";
const USER_ID = "2";
let DEV_TOKEN = process.env.DEV_AUTH_TOKEN || "test-token-123";

const HEADERS = {
  "Content-Type": "application/json",
  "Authorization": "Bearer " + DEV_TOKEN
};

const TestResults = {
  passed: 0,
  failed: 0,
  skipped: 0
};

// Create log file
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFilePath = path.join(__dirname, `test_results_${timestamp}.json`);
const fullLog = [];

// Helper: Log to console and accumulate for file
function log(message) {
  console.log(message);
}

// Helper: Print header
function header(title) {
  log(`\n===============================================================`);
  log(title);
  log(`===============================================================`);
}

// Helper: Run API Test
async function testEndpoint(name, url, method = "GET", body = null, headers = HEADERS) {
  log(`\nTEST: ${name}`);
  log(`  URL: ${method} ${url}`);

  const testEntry = {
    testName: name,
    url: url,
    method: method,
    requestBody: body,
    timestamp: new Date().toISOString(),
    status: "PENDING",
    response: null,
    error: null
  };

  try {
    const options = {
      method,
      headers
    };

    if (body && method !== "GET") {
      options.body = JSON.stringify(body);
      log(`  Body: ${options.body}`);
    }

    const res = await fetch(url, options);

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`HTTP ${res.status} - ${errorText}`);
    }

    const json = await res.json();
    log("  SUCCESS");

    let display = JSON.stringify(json);
    if (display.length > 200) {
      display = display.substring(0, 200) + "...";
    }
    log(`  Response: ${display}`);

    TestResults.passed++;
    testEntry.status = "PASSED";
    testEntry.response = json;
    fullLog.push(testEntry);
    return json;
  } catch (err) {
    log(`  FAILED: ${err.message}`);
    TestResults.failed++;
    testEntry.status = "FAILED";
    testEntry.error = err.message;
    fullLog.push(testEntry);
    return null;
  }
}

// Helper: Test agent conversation
async function testAgent(agentName, message, expectedKeyword = "") {
  const body = {
    userId: USER_ID,
    message
  };

  const res = await testEndpoint(
    `${agentName} Agent: '${message}'`,
    `${BASE_URL}/api/agent`,
    "POST",
    body
  );

  if (expectedKeyword && res && res.message) {
    if (res.message.includes(expectedKeyword)) {
      log(`  OK: Response contains "${expectedKeyword}"`);
    } else {
      log(`  WARNING: Response missing "${expectedKeyword}"`);
    }
  }

  return res;
}

// ============================================================================
// START RUN
// ============================================================================

(async function () {

  log("\n===============================================================");
  log("Convo_Check API Feature Test Suite");
  log("===============================================================");

  // ------------------------------------------------------------------------
  // 1. SMS INGESTION + PROCESSING
  // ------------------------------------------------------------------------
  header("1. SMS INGESTION & PROCESSING (Dev Agent)");

  await testEndpoint(
    "SMS Ingestion",
    `${BASE_URL}/api/sms/ingest`,
    "POST",
    {
      userPhone: "919619183585",
      smsBody: "You spent Rs 1250 at Amazon on 15-Nov-2025. -HDFC Bank",
      receivedAt: new Date().toISOString()
    }
  );

  await testEndpoint(
    "SMS Queue Processing",
    `${BASE_URL}/api/sms/process-queue`,
    "POST"
  );

  // ------------------------------------------------------------------------
  // 2. MILL AGENT
  // ------------------------------------------------------------------------
  header("2. MILL AGENT - Transaction Logging & Queries");

  await testAgent("Mill", "I spent 250 rupees on groceries today", "transaction");
  await testAgent("Mill", "What did I spend yesterday?");
  await testAgent("Mill", "Show me my total spending this month");

  // ------------------------------------------------------------------------
  // 3. CHATUR AGENT
  // ------------------------------------------------------------------------
  header("3. CHATUR AGENT - Financial Coaching");

  await testAgent("Chatur", "How can I save more money?", "save");
  await testAgent("Chatur", "Give me tips to reduce my food expenses");
  await testAgent("Chatur", "Help me create a budget", "budget");

  // ------------------------------------------------------------------------
  // 4. SERA AGENT
  // ------------------------------------------------------------------------
  header("4. SERA AGENT - Shopping Assistant");

  await testAgent("Sera", "I want to buy a laptop under 50000 rupees");

  // ------------------------------------------------------------------------
  // 5. GROUNDED SEARCH
  // ------------------------------------------------------------------------
  header("5. GROUNDED SEARCH");

  await testEndpoint(
    "Grounded Search",
    `${BASE_URL}/api/grounded-search`,
    "POST",
    {
      query: "best budget smartphones in India",
      num: 5
    }
  );
  // ------------------------------------------------------------------------
  // 6. ERROR TESTS
  // ------------------------------------------------------------------------
  header("6. ERROR HANDLING");

  log("\n🧪 Invalid Request (Missing userId)");
  try {
    await fetch(`${BASE_URL}/api/agent`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "test" })
    });
    log("  ⚠️ UNEXPECTED: Should have failed");
  } catch (e) {
    log("  ✅ Expected error caught");
    TestResults.passed++;
  }

  log("\n🧪 Protected Endpoint Without Auth");
  try {
    await fetch(`${BASE_URL}/api/protected`, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    log("  ⚠️ UNEXPECTED: Should require auth");
  } catch (e) {
    log("  ✅ Expected auth error");
    TestResults.passed++;
  }

  // ------------------------------------------------------------------------
  // SUMMARY
  // ------------------------------------------------------------------------
  header("TEST SUMMARY");

  const total = TestResults.passed + TestResults.failed + TestResults.skipped;
  const successRate = total > 0 ? ((TestResults.passed / total) * 100).toFixed(1) : 0;

  log(`Total Tests:  ${total}`);
  log(`Passed:       ${TestResults.passed}`);
  log(`Failed:       ${TestResults.failed}`);
  log(`Skipped:      ${TestResults.skipped}`);
  log(`\nSuccess Rate: ${successRate}%`);

  // Write full log to file
  fs.writeFileSync(logFilePath, JSON.stringify(fullLog, null, 2));
  log(`\nFull test results saved to: ${logFilePath}`);

  if (TestResults.failed === 0) {
    log("\nALL TESTS PASSED!");
    process.exit(0);
  } else {
    log("\nSome tests failed.");
    process.exit(1);
  }

})();
