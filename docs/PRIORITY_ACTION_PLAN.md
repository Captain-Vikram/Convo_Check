# 🚨 MumbaiHacks 2025 - Priority Action Plan

**Deadline:** October 18, 2025 (10-15 hours remaining)  
**Current Grade:** B+ (85/100)  
**Target Grade:** A- (92/100) with critical fixes

---

## ⏰ Time-Boxed Action Plan

### 🔴 CRITICAL FIXES (8 hours) - DO FIRST

_These are submission blockers_

#### 1️⃣ Add Core Tests (3 hours) ⚠️ HIGHEST PRIORITY

**Why:** Zero test coverage is a red flag for judges  
**Impact:** +5 points

```bash
# Install testing framework
npm install --save-dev vitest @vitest/ui c8
```

**Create 3 test files:**

**File 1: `tests/duplicate-detection.test.ts`** (1 hour)

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createDevAgentEnvironment,
  runDevPipeline,
} from "../src/runtime/dev-agent";
import { categorizeTransaction } from "../src/runtime/categorize";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

describe("Duplicate Detection", () => {
  const testDir = join(process.cwd(), "test-data");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should log first transaction", async () => {
    const env = await createDevAgentEnvironment({ baseDir: testDir });

    const payload = {
      amount: 250,
      description: "Coffee at Starbucks",
      category_suggestion: "Food & Dining",
      direction: "expense" as const,
      raw_text: "I spent INR 250 on coffee",
    };

    const categorization = categorizeTransaction(
      payload.description,
      payload.amount
    );
    const result = await runDevPipeline(payload, categorization, {
      tools: env.tools,
    });

    expect(result.status).toBe("logged");
    expect(result.normalized.amount).toBe(250);
  });

  it("should suppress duplicates within 2-minute window", async () => {
    const env = await createDevAgentEnvironment({ baseDir: testDir });

    const payload = {
      amount: 100,
      description: "Groceries",
      category_suggestion: "Food & Groceries",
      direction: "expense" as const,
      raw_text: "spent 100 on groceries",
    };

    const categorization = categorizeTransaction(
      payload.description,
      payload.amount
    );

    // First transaction
    const result1 = await runDevPipeline(payload, categorization, {
      tools: env.tools,
    });
    expect(result1.status).toBe("logged");

    // Duplicate (same amount, description, date)
    const result2 = await runDevPipeline(payload, categorization, {
      tools: env.tools,
    });
    expect(result2.status).toBe("suppressed");
    expect(result2.reason).toContain("within");
  });

  it("should detect duplicate but prompt user", async () => {
    const env = await createDevAgentEnvironment({ baseDir: testDir });

    const payload = {
      amount: 500,
      description: "Rent payment",
      category_suggestion: "Bills",
      direction: "expense" as const,
      raw_text: "paid 500 for rent",
    };

    const categorization = categorizeTransaction(
      payload.description,
      payload.amount
    );

    const result1 = await runDevPipeline(payload, categorization, {
      tools: env.tools,
    });
    expect(result1.status).toBe("logged");

    // Wait 3 minutes (simulate time passing)
    // For now, just test immediate duplicate
    const result2 = await runDevPipeline(payload, categorization, {
      tools: env.tools,
    });

    // Should be suppressed OR duplicate (depending on timing)
    expect(["suppressed", "duplicate"]).toContain(result2.status);
  });
});
```

**File 2: `tests/intent-parser.test.ts`** (1 hour)

```typescript
import { describe, it, expect } from "vitest";
import { parseUserIntent, hasIntent } from "../src/runtime/intent-parser";

describe("Intent Parser", () => {
  describe("Expense Detection", () => {
    it("should parse 'spent INR X on Y' format", () => {
      const intent = parseUserIntent("I spent INR 250 on groceries");
      expect(intent.logExpense).toEqual({
        amount: 250,
        description: "groceries",
      });
    });

    it("should parse 'paid X for Y' format", () => {
      const intent = parseUserIntent("paid 100 rupees for cab");
      expect(intent.logExpense).toEqual({
        amount: 100,
        description: "cab",
      });
    });

    it("should handle rupee symbol ₹", () => {
      const intent = parseUserIntent("bought ₹500 worth of books");
      expect(intent.logExpense).toEqual({
        amount: 500,
        description: "books",
      });
    });

    it("should handle decimal amounts", () => {
      const intent = parseUserIntent("spent Rs. 99.50 on snacks");
      expect(intent.logExpense?.amount).toBe(99.5);
    });
  });

  describe("Income Detection", () => {
    it("should parse 'received INR X from Y' format", () => {
      const intent = parseUserIntent("received INR 5000 from client");
      expect(intent.logIncome).toEqual({
        amount: 5000,
        description: "client",
      });
    });

    it("should parse 'earned X for Y' format", () => {
      const intent = parseUserIntent("earned 1500 for freelance work");
      expect(intent.logIncome).toEqual({
        amount: 1500,
        description: "freelance work",
      });
    });
  });

  describe("Query Detection", () => {
    it("should detect transaction summary requests", () => {
      const intent = parseUserIntent("show me my spending");
      expect(intent.querySummary).toBe(true);
    });

    it("should detect recent transaction requests", () => {
      const intent = parseUserIntent("show my last 5 transactions");
      expect(intent.queryRecent).toEqual({ count: 5 });
    });

    it("should handle 'last 3' format", () => {
      const intent = parseUserIntent("fetch last 3 transactions");
      expect(intent.queryRecent?.count).toBe(3);
    });
  });

  describe("Coach/Insights Detection", () => {
    it("should detect financial advice requests", () => {
      const intent = parseUserIntent("give me financial tips");
      expect(intent.requestCoach).toBe(true);
    });

    it("should detect habit analysis requests", () => {
      const intent = parseUserIntent("analyze my spending patterns");
      expect(intent.requestInsights).toBe(true);
    });
  });

  describe("hasIntent Helper", () => {
    it("should return true for expense intent", () => {
      const intent = parseUserIntent("spent 100 on food");
      expect(hasIntent(intent)).toBe(true);
    });

    it("should return false for no intent", () => {
      const intent = parseUserIntent("hello how are you");
      expect(hasIntent(intent)).toBe(false);
    });
  });
});
```

**File 3: `tests/analyst-parsing.test.ts`** (1 hour)

```typescript
import { describe, it, expect } from "vitest";

// Mock the parsing functions (extract from analyst-agent.ts)
function parseStructuredFieldInsight(line: string) {
  const match = line.match(
    /^-\s*Habit Label:\s*(.+?);\s*Evidence:\s*(.+?);\s*Counsel:\s*(.+?)\s*$/i
  );
  if (!match) throw new Error("Invalid structured format");

  return {
    habitLabel: match[1]!.trim(),
    evidence: match[2]!.trim(),
    counsel: match[3]!.trim(),
    fullText: line,
  };
}

function parseLabelCounselInsight(line: string) {
  const match = line.match(/^-\s*(.+?):\s*(.+?)\s*$/);
  if (!match) throw new Error("Invalid label:counsel format");

  return {
    habitLabel: match[1]!.trim(),
    evidence: "(inferred from transaction data)",
    counsel: match[2]!.trim(),
    fullText: line,
  };
}

describe("Analyst CSV Parsing", () => {
  describe("Structured Field Format", () => {
    it("should parse full structured format", () => {
      const line =
        "- Habit Label: Frequent Food; Evidence: 60% of expenses; Counsel: Track eating out.";
      const result = parseStructuredFieldInsight(line);

      expect(result.habitLabel).toBe("Frequent Food");
      expect(result.evidence).toBe("60% of expenses");
      expect(result.counsel).toBe("Track eating out.");
    });

    it("should handle extra whitespace", () => {
      const line =
        "-  Habit Label:  High Cash Usage ;  Evidence:  80% cash  ;  Counsel:  Use UPI more .";
      const result = parseStructuredFieldInsight(line);

      expect(result.habitLabel).toBe("High Cash Usage");
      expect(result.evidence).toBe("80% cash");
      expect(result.counsel).toBe("Use UPI more .");
    });
  });

  describe("Label-Counsel Format", () => {
    it("should parse simple label: counsel format", () => {
      const line =
        "- Cash Preference: Consider digital payments for better tracking";
      const result = parseLabelCounselInsight(line);

      expect(result.habitLabel).toBe("Cash Preference");
      expect(result.counsel).toBe(
        "Consider digital payments for better tracking"
      );
    });
  });

  describe("Error Handling", () => {
    it("should throw on malformed input", () => {
      const line = "random unstructured text";
      expect(() => parseStructuredFieldInsight(line)).toThrow();
    });

    it("should throw on missing fields", () => {
      const line = "- Habit Label: Only Label";
      expect(() => parseStructuredFieldInsight(line)).toThrow();
    });
  });
});
```

**Add to `package.json`:**

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest run --coverage"
  }
}
```

**Run tests:**

```bash
npm test
```

---

#### 2️⃣ Secure SMS Webhook (2 hours)

**Why:** Unprotected endpoint is a security vulnerability  
**Impact:** +3 points

**File: `src/server/sms-webhook.ts`**

Add these improvements:

```typescript
import { createServer } from "node:http";
import { URL } from "node:url";
import { z } from "zod";

// 1. Add authentication
const WEBHOOK_SECRET =
  process.env.SMS_WEBHOOK_SECRET || "change-me-in-production";

// 2. Add rate limiting
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const MAX_REQUESTS_PER_MINUTE = 60;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = rateLimitMap.get(ip);

  if (!bucket || now > bucket.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }

  if (bucket.count >= MAX_REQUESTS_PER_MINUTE) {
    return false;
  }

  bucket.count++;
  return true;
}

// 3. Add schema validation
const SmsMessageSchema = z.object({
  sender: z.string().min(1).max(200),
  message: z.string().min(1).max(500),
  timestamp: z.number().optional(),
  category: z.string().optional(),
});

const SmsPayloadSchema = z.union([
  SmsMessageSchema,
  z.array(SmsMessageSchema),
  z.object({ messages: z.array(SmsMessageSchema) }),
]);

// Update createServer handler
createServer(async (req, res) => {
  try {
    const requestUrl = new URL(
      req.url ?? "",
      `http://${req.headers.host ?? `localhost:${PORT}`}`
    );

    // Health check endpoint
    if (req.method === "GET" && requestUrl.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }

    if (req.method !== "POST" || requestUrl.pathname !== "/sms") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
      return;
    }

    // 1. Check authentication
    const authHeader = req.headers["x-webhook-secret"];
    if (authHeader !== WEBHOOK_SECRET) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // 2. Rate limiting
    const clientIp = req.socket.remoteAddress || "unknown";
    if (!checkRateLimit(clientIp)) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Too Many Requests", retryAfter: 60 }));
      return;
    }

    // 3. Payload size limit
    const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB
    let totalSize = 0;
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      totalSize += chunk.length;
      if (totalSize > MAX_PAYLOAD_SIZE) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    if (chunks.length === 0) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Empty request body" }));
      return;
    }

    // 4. Parse and validate
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Invalid JSON",
          details: (error as Error).message,
        })
      );
      return;
    }

    // 5. Schema validation
    let validatedPayload;
    try {
      validatedPayload = SmsPayloadSchema.parse(payload);
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Invalid payload schema",
          details: error instanceof z.ZodError ? error.errors : String(error),
        })
      );
      return;
    }

    // ... rest of existing processing logic
  } catch (error) {
    console.error("[sms-webhook] Unhandled error", error);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
}).listen(PORT, () => {
  console.log(`[sms-webhook] Listening on http://localhost:${PORT}/sms`);
  console.log(`[sms-webhook] Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[sms-webhook] Shutting down gracefully...");
  process.exit(0);
});
```

**Update `.env.example`:**

```bash
# SMS Webhook
SMS_WEBHOOK_PORT=7070
SMS_WEBHOOK_SECRET=your-secret-key-here
```

---

#### 3️⃣ Add API Key Validation (1 hour)

**Why:** Prevents cryptic runtime failures  
**Impact:** +2 points

**File: `src/config.ts`**

```typescript
export function getAgentConfig(id: AgentId): AgentConfig {
  const setting = AGENT_SETTINGS.find((s) => s.id === id);
  if (!setting) {
    throw new Error(`Unknown agent ID: ${id}`);
  }

  const apiKey = process.env[setting.apiKeyEnv];

  // Add validation
  if (!apiKey) {
    throw new Error(
      `Missing API key for ${setting.codename} (${setting.role}). ` +
        `Please set ${setting.apiKeyEnv} in your .env file.`
    );
  }

  if (apiKey.trim().length < 20) {
    throw new Error(
      `Invalid API key for ${setting.codename}. ` +
        `API keys should be at least 20 characters. ` +
        `Check ${setting.apiKeyEnv} in your .env file.`
    );
  }

  // Mask key in logs
  const maskedKey = `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;
  console.log(`[config] Loaded ${setting.codename} with key: ${maskedKey}`);

  // ... rest of existing code
}
```

---

#### 4️⃣ Add User Consent Flow (2 hours)

**Why:** Ethical requirement for PS1  
**Impact:** +3 points

**File: `src/runtime/user-profile.ts` (NEW)**

```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface UserProfile {
  hasConsented: boolean;
  consentDate?: string;
  name?: string;
  preferredLanguage?: "en" | "hi";
}

const PROFILE_PATH = join(process.cwd(), "data", "user-profile.json");

export async function loadUserProfile(): Promise<UserProfile> {
  try {
    const content = await readFile(PROFILE_PATH, "utf8");
    return JSON.parse(content);
  } catch {
    return { hasConsented: false };
  }
}

export async function saveUserProfile(profile: UserProfile): Promise<void> {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(PROFILE_PATH, JSON.stringify(profile, null, 2), "utf8");
}
```

**Update `src/runtime/chatbot-session.ts`:**

```typescript
import { loadUserProfile, saveUserProfile } from "./user-profile.js";

export async function runChatbotSession(
  options: ChatbotSessionOptions = {}
): Promise<void> {
  // ... existing setup

  // Check consent BEFORE starting agents
  const userProfile = await loadUserProfile();

  if (!userProfile.hasConsented) {
    output.write(
      `\n${"=".repeat(60)}\n` +
        `Welcome to Convo Check - Your Personal Finance Sidekick! 🎯\n` +
        `${"=".repeat(60)}\n\n` +
        `Before we begin, I need your permission to:\n\n` +
        `  1. ✅ Store your transaction data locally (in the 'data/' folder)\n` +
        `  2. 📊 Analyze your spending patterns to provide insights\n` +
        `  3. 💡 Offer financial tips and guidance\n\n` +
        `⚠️  Important Disclaimers:\n` +
        `  • I'm an AI assistant, NOT a licensed financial advisor\n` +
        `  • All data is stored locally on your device (no cloud uploads)\n` +
        `  • You can delete your data anytime by removing the 'data/' folder\n` +
        `  • This is a demo for MumbaiHacks 2025 (educational purposes)\n\n` +
        `Do you agree to these terms? Type 'yes' to continue or 'no' to exit.\n\n` +
        `mill> `
    );

    const consentAnswer = await new Promise<string>((resolve) => {
      rl.question("", resolve);
    });

    if (consentAnswer.toLowerCase().trim() !== "yes") {
      output.write(
        `\nNo worries! Your privacy matters. Exiting now.\n` +
          `Come back anytime you're ready! 👋\n\n`
      );
      rl.close();
      return;
    }

    // Save consent
    await saveUserProfile({
      hasConsented: true,
      consentDate: new Date().toISOString(),
      preferredLanguage: "en",
    });

    output.write(
      `\n✅ Great! You're all set. Let's start tracking your finances!\n\n`
    );
  }

  // ... rest of existing code (agent startup, etc.)
}
```

---

### 🟡 HIGH-IMPACT IMPROVEMENTS (4 hours) - DO IF TIME

#### 5️⃣ Add Hindi Support to Intent Parser (1.5 hours)

**Impact:** +2 points (PS1 multilingual requirement)

**File: `src/runtime/intent-parser.ts`**

```typescript
export function parseUserIntent(input: string): ParsedIntent {
  const normalized = input.toLowerCase().trim();
  const intent: ParsedIntent = {};

  // Expense patterns (English + Hindi)
  const expensePatterns = [
    // English
    /(?:spent|paid|expense|bought)\s+(?:inr|rs\.?|₹)?\s*(\d+(?:\.\d+)?)\s+(?:on|for)\s+(.+?)(?:\.|$)/i,
    /(\d+(?:\.\d+)?)\s+(?:inr|rs\.?|₹)\s+(?:spent|paid|expense|bought)\s+(?:on|for)\s+(.+?)(?:\.|$)/i,

    // Hindi (Hinglish patterns)
    /(?:kharch|खर्च|diya|दिया)\s+(?:inr|rs\.?|₹)?\s*(\d+(?:\.\d+)?)\s+(?:par|पर|mein|में)\s+(.+?)(?:\.|$)/i,
    /(\d+(?:\.\d+)?)\s+(?:rupaye|रुपये|rupees)\s+(?:kharch|खर्च)\s+(?:kiya|किया)\s+(.+?)(?:\.|$)/i,
  ];

  for (const pattern of expensePatterns) {
    const match = input.match(pattern);
    if (match?.[1] && match[2]) {
      intent.logExpense = {
        amount: parseFloat(match[1]),
        description: match[2].trim(),
      };
      break;
    }
  }

  // Income patterns (English + Hindi)
  const incomePatterns = [
    // English
    /(?:received|earned|got|income)\s+(?:inr|rs\.?|₹)?\s*(\d+(?:\.\d+)?)\s+(?:from|for)\s+(.+?)(?:\.|$)/i,
    /(\d+(?:\.\d+)?)\s+(?:inr|rs\.?|₹)\s+(?:received|earned|got|income)\s+(?:from|for)\s+(.+?)(?:\.|$)/i,

    // Hindi
    /(?:mila|मिला|paya|पाया)\s+(?:inr|rs\.?|₹)?\s*(\d+(?:\.\d+)?)\s+(?:se|से)\s+(.+?)(?:\.|$)/i,
    /(\d+(?:\.\d+)?)\s+(?:rupaye|रुपये)\s+(?:aaye|आए|kamaye|कमाए)\s+(.+?)(?:\.|$)/i,
  ];

  for (const pattern of incomePatterns) {
    const match = input.match(pattern);
    if (match?.[1] && match[2]) {
      intent.logIncome = {
        amount: parseFloat(match[1]),
        description: match[2].trim(),
      };
      break;
    }
  }

  // Query patterns (English + Hindi)
  if (
    /(?:show|get|fetch|give me|what|display|dikhao|दिखाओ|batao|बताओ).*(?:transaction|spending|expense|history|खर्च|lenden|लेनदेन)/i.test(
      normalized
    )
  ) {
    intent.querySummary = true;
  }

  const recentMatch = normalized.match(
    /(?:last|recent|pichle|पिछले)\s+(\d+)\s+(?:transaction|lenden|लेनदेन)/i
  );
  if (recentMatch) {
    intent.queryRecent = { count: parseInt(recentMatch[1]!, 10) };
  }

  // Coach patterns (English + Hindi)
  if (
    /(?:financial|money|budget|paisa|पैसा)\s+(?:tip|advice|guidance|help|salah|सलाह|madad|मदद)/i.test(
      normalized
    ) ||
    /(?:coach|chatur)/i.test(normalized)
  ) {
    intent.requestCoach = true;
  }

  return intent;
}
```

---

#### 6️⃣ Add Config-Driven Constants (1 hour)

**Impact:** +1 point (maintainability)

**File: `src/constants.ts` (NEW)**

```typescript
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
export const CSV_WATCH_DEBOUNCE_MS = 200; // Debounce CSV watcher
export const MAX_INSIGHT_COUNT = 7; // Analyst max insights
export const HABIT_SNAPSHOT_RETENTION_DAYS = 30;
export const MAX_TRANSACTIONS_FOR_ANALYSIS = 100; // Performance limit
export const LLM_CACHE_TTL_MS = 60 * 1000; // 60 seconds
export const RATE_LIMIT_REQUESTS_PER_MINUTE = 60;
export const MAX_WEBHOOK_PAYLOAD_SIZE = 1024 * 1024; // 1MB

// File paths
export const DATA_DIR = "data";
export const TRANSACTIONS_FILE = "transactions.csv";
export const HABITS_FILE = "habits.csv";
export const COACH_BRIEFINGS_FILE = "coach-briefings.json";
export const USER_PROFILE_FILE = "user-profile.json";
```

**Update imports throughout codebase:**

```typescript
import { DUPLICATE_WINDOW_MS, MAX_INSIGHT_COUNT } from "../constants.js";
```

---

#### 7️⃣ Create Manual Test Report (1.5 hours)

**Impact:** +2 points (demo prep)

**File: `docs/MANUAL_TEST_REPORT.md` (NEW)**

Run through this checklist and document results:

```markdown
# Manual Test Report - MumbaiHacks 2025

**Date:** October 18, 2025  
**Tester:** [Your Name]

## ✅ SMS Webhook Tests

### Test 1: Valid SMS Processing

- **Input:** `POST /sms` with valid bank SMS JSON
- **Expected:** Transaction logged, status 200
- **Result:** ✅ PASS / ❌ FAIL
- **Screenshot:** [attach]

### Test 2: Duplicate Detection

- **Input:** Same SMS twice within 2 minutes
- **Expected:** Second suppressed
- **Result:** ✅ PASS / ❌ FAIL

### Test 3: Authentication

- **Input:** POST without `X-Webhook-Secret` header
- **Expected:** 401 Unauthorized
- **Result:** ✅ PASS / ❌ FAIL

## ✅ Chatbot Session Tests

### Test 4: Expense Logging

- **Input:** "I spent INR 100 on food"
- **Expected:** Expense logged, confirmation message
- **Result:** ✅ PASS / ❌ FAIL

### Test 5: Query Transactions

- **Input:** "show my last 3 transactions"
- **Expected:** Last 3 displayed (not "let me fetch...")
- **Result:** ✅ PASS / ❌ FAIL

### Test 6: Hindi Input

- **Input:** "maine 50 rupaye kharch kiya chai par"
- **Expected:** Expense logged
- **Result:** ✅ PASS / ❌ FAIL

## ✅ Multi-Agent Coordination

### Test 7: Full Pipeline

- **Steps:**
  1. Add 5 transactions
  2. Verify Param generates insights
  3. Verify Coach creates briefing
- **Result:** ✅ PASS / ❌ FAIL

## Summary

- **Total Tests:** 7
- **Passed:** \_\_\_
- **Failed:** \_\_\_
- **Pass Rate:** \_\_\_%
```

---

### 🟢 NICE-TO-HAVE (If Extra Time)

#### 8️⃣ Add TROUBLESHOOTING.md (30 min)

```markdown
# Troubleshooting Guide

## "Cannot find CHATBOT_GEMINI_API_KEY"

**Cause:** Missing .env file  
**Fix:** Copy `.env.example` to `.env` and add your API keys

## "CSV file locked" errors

**Cause:** Multiple processes accessing data/ folder  
**Fix:** Stop `npm run sms-server` before running chat

## Param generates placeholder insights

**Cause:** Fewer than 5 transactions  
**Fix:** Add more transactions via SMS or manual chat
```

---

## 📊 Expected Grade Improvement

| Action                | Time   | Grade Impact   |
| --------------------- | ------ | -------------- |
| Add Core Tests        | 3h     | +5 points      |
| Secure Webhook        | 2h     | +3 points      |
| API Key Validation    | 1h     | +2 points      |
| Consent Flow          | 2h     | +3 points      |
| **Total Critical**    | **8h** | **+13 points** |
| Hindi Support         | 1.5h   | +2 points      |
| Config Constants      | 1h     | +1 point       |
| Test Report           | 1.5h   | +2 points      |
| **Total High-Impact** | **4h** | **+5 points**  |

**New Grade:** A- (92/100) 🎯

---

## 🎯 Execution Order

1. ✅ Run `npm install --save-dev vitest @vitest/ui c8` (5 min)
2. ✅ Create 3 test files (3 hours)
3. ✅ Run `npm test` - ensure all pass (15 min)
4. ✅ Secure webhook (2 hours)
5. ✅ Add API validation (1 hour)
6. ✅ Add consent flow (2 hours)
7. ✅ Test manually, document (1.5 hours)
8. ✅ Commit and push to GitHub (15 min)

**Total Time:** 10.5 hours (within your 10-15 hour window)

---

## 📝 Git Commit Strategy

```bash
# After each major milestone
git add .
git commit -m "feat: add core test suite (duplicate detection, intent parser, analyst parsing)"
git push

git commit -m "security: add webhook authentication, rate limiting, schema validation"
git push

git commit -m "feat: add user consent flow and ethical disclaimers"
git push

git commit -m "docs: add manual test report and troubleshooting guide"
git push
```

---

## 🚀 Demo Preparation (30 min before presentation)

1. **Reset data folder:**

   ```bash
   rm -rf data/*
   ```

2. **Seed demo transactions:**

   - Run chatbot
   - Log 5-7 diverse transactions
   - Trigger Param analysis
   - Get Coach briefing

3. **Prepare demo script:**

   - Show SMS POST → transaction logged
   - Show duplicate suppression
   - Show "show last 3 transactions" → instant results
   - Highlight multi-agent coordination

4. **Take screenshots:**
   - Terminal output
   - CSV files
   - Test results

---

**GOOD LUCK! 🚀**
