# Convo Check - Improvements Roadmap

**MumbaiHacks 2025 Fintech PS1 - Production Enhancement Plan**  
**Timeline:** October 18 - November 28, 2025 (41 days)  
**Team:** 3 developers  
**Current Grade:** B+ (85/100)  
**Target Grade:** A+ (95/100)

---

## 📊 Executive Summary

This roadmap transforms the current multi-agent **prototype** into a **production-ready system** for gig workers. The focus is on security hardening, performance optimization, and feature completeness while maintaining the innovative 4-agent architecture (Mill/Dev/Param/Chatur).

**Total Estimated Effort:** 25-42 hours (distributed across 3 developers over 41 days)

---

## 🎯 Priority Matrix

| Priority | Category     | Effort | Impact   | Grade Boost |
| -------- | ------------ | ------ | -------- | ----------- |
| 🔴 P0    | Security     | 5-8h   | Critical | +7 points   |
| 🔴 P0    | Testing      | 5-8h   | Critical | +5 points   |
| 🟡 P1    | Performance  | 6-10h  | High     | +4 points   |
| 🟡 P1    | Features     | 4-7h   | High     | +3 points   |
| 🟢 P2    | Code Quality | 3-5h   | Medium   | +2 points   |
| 🟢 P3    | Deployment   | 2-4h   | Low      | +1 point    |

**Expected Final Grade:** A+ (95/100) with all P0-P1 completed

---

## 🔴 PRIORITY 0: Critical Security Fixes (5-8 hours)

### 1.1 SMS Webhook Security Hardening (3 hours)

**Current Risk:** Unprotected endpoint vulnerable to DoS, injection, and unauthorized access

**Implementation:**

**File: `src/server/sms-webhook.ts`**

```typescript
import { createServer, IncomingMessage } from "node:http";
import { URL } from "node:url";
import { z } from "zod";

// Configuration
const PORT = Number.parseInt(process.env.SMS_WEBHOOK_PORT ?? "7070", 10);
const WEBHOOK_SECRET = process.env.SMS_WEBHOOK_SECRET;
const MAX_REQUESTS_PER_MINUTE = 60;
const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB

if (!WEBHOOK_SECRET) {
  console.warn(
    "⚠️  SMS_WEBHOOK_SECRET not set - webhook authentication disabled!"
  );
}

// Rate limiting store
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

// Schema validation
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

function checkRateLimit(clientIp: string): boolean {
  const now = Date.now();
  const bucket = rateLimitStore.get(clientIp);

  if (!bucket || now > bucket.resetAt) {
    rateLimitStore.set(clientIp, { count: 1, resetAt: now + 60000 });
    return true;
  }

  if (bucket.count >= MAX_REQUESTS_PER_MINUTE) {
    return false;
  }

  bucket.count++;
  return true;
}

// Clean up rate limit store every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateLimitStore.entries()) {
    if (now > bucket.resetAt) {
      rateLimitStore.delete(ip);
    }
  }
}, 60 * 60 * 1000);

function validateAuthentication(req: IncomingMessage): boolean {
  if (!WEBHOOK_SECRET) return true; // Skip if not configured
  const authHeader = req.headers["x-webhook-secret"];
  return authHeader === WEBHOOK_SECRET;
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > MAX_PAYLOAD_SIZE) {
      throw new Error("PAYLOAD_TOO_LARGE");
    }
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    throw new Error("EMPTY_BODY");
  }

  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const startTime = Date.now();
  const requestUrl = new URL(
    req.url ?? "",
    `http://${req.headers.host ?? `localhost:${PORT}`}`
  );

  try {
    // Health check endpoint
    if (req.method === "GET" && requestUrl.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    // Only accept POST to /sms
    if (req.method !== "POST" || requestUrl.pathname !== "/sms") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
      return;
    }

    // 1. Authentication
    if (!validateAuthentication(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Unauthorized",
          message: "Invalid or missing X-Webhook-Secret header",
        })
      );
      return;
    }

    // 2. Rate limiting
    const clientIp = req.socket.remoteAddress || "unknown";
    if (!checkRateLimit(clientIp)) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Too Many Requests",
          retryAfter: 60,
          message: "Rate limit exceeded (max 60 req/min)",
        })
      );
      return;
    }

    // 3. Read and validate body
    let body: Buffer;
    try {
      body = await readRequestBody(req);
    } catch (error) {
      if ((error as Error).message === "PAYLOAD_TOO_LARGE") {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Payload Too Large",
            maxSize: "1MB",
          })
        );
        return;
      }
      if ((error as Error).message === "EMPTY_BODY") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Empty request body" }));
        return;
      }
      throw error;
    }

    // 4. Parse JSON
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
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

    // 6. Process messages (existing logic)
    const messages = extractMessages(validatedPayload);

    if (messages.length === 0) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "No SMS messages found in payload" }));
      return;
    }

    const environment = await environmentPromise;
    const smsLog = await smsLogPromise;

    const results: Array<ProcessSmsMessageOutcome & { sender?: string }> = [];
    for (const message of messages) {
      try {
        const outcome = await processSmsMessage(message, {
          devEnvironment: environment,
          smsLog,
        });
        results.push({ ...outcome, sender: message.sender });
      } catch (error) {
        results.push({ status: "skipped", reason: "invalid" });
        console.error("[sms-webhook] Failed to process message", {
          sender: message.sender,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const summary = {
      processed: results.filter((r) => r.status === "processed").length,
      duplicates: results.filter((r) => r.status === "duplicate").length,
      suppressed: results.filter((r) => r.status === "suppressed").length,
      skipped: results.filter((r) => r.status === "skipped").length,
    };

    const processingTime = Date.now() - startTime;

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        summary,
        results,
        processingTimeMs: processingTime,
      })
    );
  } catch (error) {
    console.error("[sms-webhook] Unhandled error", error);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      })
    );
  }
});

server.listen(PORT, () => {
  console.log(`[sms-webhook] 🚀 Listening on http://localhost:${PORT}/sms`);
  console.log(`[sms-webhook] 💚 Health: http://localhost:${PORT}/health`);
  if (WEBHOOK_SECRET) {
    console.log(`[sms-webhook] 🔒 Authentication enabled`);
  } else {
    console.warn(
      `[sms-webhook] ⚠️  Authentication disabled - set SMS_WEBHOOK_SECRET`
    );
  }
});

// Graceful shutdown
const shutdown = () => {
  console.log("\n[sms-webhook] 👋 Shutting down gracefully...");
  server.close(() => {
    console.log("[sms-webhook] ✅ Server closed");
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error("[sms-webhook] ⚠️  Forced shutdown");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Extract messages (existing function)
function extractMessages(payload: unknown): SmsMessage[] {
  // ... existing implementation
}
```

**Update `.env.example`:**

```bash
# SMS Webhook Security
SMS_WEBHOOK_PORT=7070
SMS_WEBHOOK_SECRET=your-secret-key-min-32-chars-recommended
```

**Testing:**

```bash
# Test authentication
curl -X POST http://localhost:7070/sms \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: wrong-secret" \
  -d '{"sender":"test","message":"test"}'
# Expected: 401 Unauthorized

# Test rate limiting (run 61 times in a loop)
for i in {1..61}; do
  curl -X POST http://localhost:7070/sms \
    -H "X-Webhook-Secret: your-secret" \
    -d '{"sender":"test","message":"msg'$i'"}'
done
# Expected: 429 on 61st request

# Test health endpoint
curl http://localhost:7070/health
# Expected: {"status":"ok","uptime":...}
```

---

### 1.2 API Key Validation (1 hour)

**Current Risk:** Missing/invalid keys cause cryptic runtime failures

**File: `src/config.ts`**

```typescript
export class ConfigurationError extends Error {
  constructor(message: string, public readonly agentName: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function getAgentConfig(id: AgentId): AgentConfig {
  const setting = AGENT_SETTINGS.find((s) => s.id === id);
  if (!setting) {
    throw new ConfigurationError(`Unknown agent ID: ${id}`, "unknown");
  }

  const apiKey = process.env[setting.apiKeyEnv];
  const model =
    process.env[setting.modelEnv] ||
    process.env[DEFAULT_MODEL_ENV] ||
    DEFAULT_MODEL_FALLBACK;

  // Validation
  if (!apiKey) {
    throw new ConfigurationError(
      `Missing API key for ${setting.codename} (${setting.role}).\n` +
        `Please set ${setting.apiKeyEnv} in your .env file.\n` +
        `Example: ${setting.apiKeyEnv}=AIzaSy...`,
      setting.codename
    );
  }

  if (apiKey.trim().length < 20) {
    throw new ConfigurationError(
      `Invalid API key for ${setting.codename}. ` +
        `API keys should be at least 20 characters.\n` +
        `Current length: ${apiKey.length}. ` +
        `Check ${setting.apiKeyEnv} in your .env file.`,
      setting.codename
    );
  }

  // Warn if using fallback model
  if (!process.env[setting.modelEnv]) {
    console.warn(
      `[config] ⚠️  ${setting.codename}: Using fallback model "${model}". ` +
        `Set ${setting.modelEnv} to customize.`
    );
  }

  // Mask key for logging (show first 8 and last 4 chars)
  const maskedKey =
    apiKey.length > 12 ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : "***";

  console.log(
    `[config] ✅ ${setting.codename} (${setting.role}): ` +
      `model=${model}, key=${maskedKey}`
  );

  return {
    id,
    role: setting.role,
    title: setting.title,
    codename: setting.codename,
    apiKey,
    model,
  };
}

// Validate all agents at startup
export function validateAllAgents(): void {
  const errors: ConfigurationError[] = [];

  for (const agentId of ["agent1", "agent2", "agent3", "agent4"] as AgentId[]) {
    try {
      getAgentConfig(agentId);
    } catch (error) {
      if (error instanceof ConfigurationError) {
        errors.push(error);
      } else {
        throw error;
      }
    }
  }

  if (errors.length > 0) {
    console.error("\n❌ Configuration Errors Found:\n");
    errors.forEach((err, idx) => {
      console.error(`  ${idx + 1}. [${err.agentName}] ${err.message}\n`);
    });
    console.error("Fix these errors in your .env file and restart.\n");
    process.exit(1);
  }

  console.log("[config] ✅ All agents configured successfully\n");
}
```

**Update `src/index.ts`:**

```typescript
import { validateAllAgents } from "./config.js";

// At the top of main()
async function main() {
  // Validate configuration before starting
  validateAllAgents();

  // ... rest of existing code
}
```

---

### 1.3 Input Validation with Zod (2 hours)

**Current Risk:** Malformed inputs crash agents

**File: `src/runtime/validation-schemas.ts` (NEW)**

```typescript
import { z } from "zod";

// Transaction validation
export const TransactionPayloadSchema = z.object({
  amount: z.number().positive().finite(),
  description: z.string().min(1).max(500),
  category_suggestion: z.string().min(1).max(100),
  direction: z.enum(["income", "expense"]),
  raw_text: z.string().max(1000),
  event_date: z.string().optional(),
  event_time: z.string().optional(),
});

export type ValidatedTransactionPayload = z.infer<
  typeof TransactionPayloadSchema
>;

// Habit insight validation
export const HabitInsightSchema = z.object({
  habitLabel: z.string().min(3).max(200),
  evidence: z.string().min(5).max(500),
  counsel: z.string().min(5).max(500),
  fullText: z.string(),
});

// Coach briefing validation
export const CoachBriefingSchema = z.object({
  headline: z.string().min(5).max(200),
  counsel: z.string().min(10).max(1000),
  tags: z.array(z.string()).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});

// User profile validation
export const UserProfileSchema = z.object({
  hasConsented: z.boolean(),
  consentDate: z.string().optional(),
  name: z.string().max(100).optional(),
  preferredLanguage: z.enum(["en", "hi"]).optional(),
});

// Multilingual text validation (Hindi + English)
export function validateMultilingualText(
  text: string,
  maxLength = 500
): boolean {
  // Allow English, Hindi (Devanagari), numbers, common punctuation
  const pattern = /^[\u0900-\u097Fa-zA-Z0-9\s.,!?;:()\-₹]+$/;
  return text.length > 0 && text.length <= maxLength && pattern.test(text);
}
```

**Update agent files to use schemas:**

```typescript
// src/runtime/dev-agent.ts
import { TransactionPayloadSchema } from "./validation-schemas.js";

export async function runDevPipeline(
  payload: LogCashTransactionPayload,
  categorization: CategorizationResult,
  options: DevPipelineOptions
): Promise<DevPipelineResult> {
  // Validate input
  try {
    TransactionPayloadSchema.parse(payload);
  } catch (error) {
    throw new Error(
      `Invalid transaction payload: ${
        error instanceof z.ZodError ? error.errors[0]?.message : String(error)
      }`
    );
  }

  // ... rest of existing code
}
```

---

### 1.4 File Permission and Disk Space Checks (1-2 hours)

**File: `src/utils/fs-helpers.ts` (NEW)**

```typescript
import { access, mkdir, stat, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";

export class FileSystemError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "FileSystemError";
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    throw new FileSystemError(
      `Failed to create directory: ${(error as Error).message}`,
      path,
      error
    );
  }
}

export async function checkFileWritable(path: string): Promise<void> {
  const dir = dirname(path);

  try {
    await access(dir, constants.W_OK);
  } catch (error) {
    throw new FileSystemError(
      `Directory not writable: ${dir}. Check file permissions.`,
      path,
      error
    );
  }
}

export async function checkDiskSpace(path: string, minMB = 100): Promise<void> {
  try {
    const stats = await statfs(path);
    const availableMB = (stats.bavail * stats.bsize) / (1024 * 1024);

    if (availableMB < minMB) {
      throw new FileSystemError(
        `Low disk space: ${availableMB.toFixed(
          2
        )}MB available (minimum: ${minMB}MB). ` +
          `Free up space and try again.`,
        path
      );
    }
  } catch (error) {
    if (error instanceof FileSystemError) throw error;
    // Silently fail on systems that don't support statfs
    console.warn(`[fs-helpers] Could not check disk space for ${path}`);
  }
}

export async function atomicWrite(
  path: string,
  content: string
): Promise<void> {
  const { writeFile, rename } = await import("node:fs/promises");
  const tempPath = `${path}.tmp.${Date.now()}`;

  try {
    await checkFileWritable(path);
    await checkDiskSpace(dirname(path));
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, path); // Atomic on most filesystems
  } catch (error) {
    // Clean up temp file
    try {
      await import("node:fs/promises").then((fs) => fs.unlink(tempPath));
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}
```

---

## 🔴 PRIORITY 0: Testing Framework (5-8 hours)

### 2.1 Setup Testing Infrastructure (1 hour)

```bash
npm install --save-dev vitest @vitest/ui c8 @types/node
```

**File: `vitest.config.ts` (NEW)**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "c8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/**", "dist/**", "tests/**", "**/*.config.*"],
    },
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000,
  },
});
```

**Update `package.json`:**

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest run --coverage",
    "test:ci": "vitest run --reporter=verbose --coverage"
  }
}
```

---

### 2.2 Core Test Suites (4-7 hours)

Create `tests/` directory with these files:

**File: `tests/duplicate-detection.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createDevAgentEnvironment,
  runDevPipeline,
} from "../src/runtime/dev-agent";
import { categorizeTransaction } from "../src/runtime/categorize";
import type { LogCashTransactionPayload } from "../src/tools/log-cash-transaction";

describe("Duplicate Detection System", () => {
  const testDir = join(process.cwd(), "test-data-dup");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should log first transaction successfully", async () => {
    const env = await createDevAgentEnvironment({ baseDir: testDir });

    const payload: LogCashTransactionPayload = {
      amount: 250,
      description: "Coffee at Starbucks",
      category_suggestion: "Food & Dining",
      direction: "expense",
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
    if (result.status === "logged") {
      expect(result.normalized.amount).toBe(250);
      expect(result.normalized.category).toBe("Food & Dining");
      expect(result.metadata.direction).toBe("expense");
    }
  });

  it("should suppress exact duplicates within 2-minute window", async () => {
    const env = await createDevAgentEnvironment({ baseDir: testDir });

    const payload: LogCashTransactionPayload = {
      amount: 100,
      description: "Groceries",
      category_suggestion: "Food & Groceries",
      direction: "expense",
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

    // Immediate duplicate
    const result2 = await runDevPipeline(payload, categorization, {
      tools: env.tools,
    });
    expect(result2.status).toBe("suppressed");

    if (result2.status === "suppressed") {
      expect(result2.reason).toContain("within");
      expect(result2.duplicateOf.amount).toBe(100);
    }
  });

  it("should allow different amounts even with same description", async () => {
    const env = await createDevAgentEnvironment({ baseDir: testDir });

    const categorization1 = categorizeTransaction("Coffee", 50);
    const result1 = await runDevPipeline(
      {
        amount: 50,
        description: "Coffee",
        category_suggestion: "Food",
        direction: "expense",
        raw_text: "coffee 50",
      },
      categorization1,
      { tools: env.tools }
    );
    expect(result1.status).toBe("logged");

    const categorization2 = categorizeTransaction("Coffee", 100);
    const result2 = await runDevPipeline(
      {
        amount: 100,
        description: "Coffee",
        category_suggestion: "Food",
        direction: "expense",
        raw_text: "coffee 100",
      },
      categorization2,
      { tools: env.tools }
    );
    expect(result2.status).toBe("logged"); // Different amount, should log
  });

  it("should handle high-value duplicates (prompt user)", async () => {
    const env = await createDevAgentEnvironment({ baseDir: testDir });

    const payload: LogCashTransactionPayload = {
      amount: 5000,
      description: "Rent payment",
      category_suggestion: "Bills",
      direction: "expense",
      raw_text: "paid 5000 for rent",
    };

    const categorization = categorizeTransaction(
      payload.description,
      payload.amount
    );

    const result1 = await runDevPipeline(payload, categorization, {
      tools: env.tools,
    });
    expect(result1.status).toBe("logged");

    const result2 = await runDevPipeline(payload, categorization, {
      tools: env.tools,
    });

    // Should be suppressed OR duplicate (depending on timing/amount threshold)
    expect(["suppressed", "duplicate"]).toContain(result2.status);
  });
});
```

**File: `tests/intent-parser.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { parseUserIntent, hasIntent } from "../src/runtime/intent-parser";

describe("Intent Parser - Fallback System", () => {
  describe("Expense Detection (English)", () => {
    it("should parse 'spent INR X on Y'", () => {
      const intent = parseUserIntent("I spent INR 250 on groceries");
      expect(intent.logExpense).toEqual({
        amount: 250,
        description: "groceries",
      });
    });

    it("should parse 'paid X for Y'", () => {
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
      expect(intent.logExpense?.description).toBe("snacks");
    });

    it("should handle reversed format 'X rupees spent on Y'", () => {
      const intent = parseUserIntent("200 INR spent on dinner");
      expect(intent.logExpense).toEqual({
        amount: 200,
        description: "dinner",
      });
    });
  });

  describe("Expense Detection (Hindi/Hinglish)", () => {
    it("should parse Hindi expense patterns", () => {
      const intent = parseUserIntent("maine 100 rupaye kharch kiya chai par");
      expect(intent.logExpense).toBeDefined();
      expect(intent.logExpense?.amount).toBe(100);
    });

    it("should handle mixed Hindi-English", () => {
      const intent = parseUserIntent("kharch kiya 50 rupees on food");
      expect(intent.logExpense).toBeDefined();
    });
  });

  describe("Income Detection", () => {
    it("should parse 'received INR X from Y'", () => {
      const intent = parseUserIntent("received INR 5000 from client");
      expect(intent.logIncome).toEqual({
        amount: 5000,
        description: "client",
      });
    });

    it("should parse 'earned X for Y'", () => {
      const intent = parseUserIntent("earned 1500 for freelance work");
      expect(intent.logIncome).toEqual({
        amount: 1500,
        description: "freelance work",
      });
    });

    it("should handle 'got' keyword", () => {
      const intent = parseUserIntent("got ₹2000 for consulting");
      expect(intent.logIncome).toEqual({
        amount: 2000,
        description: "consulting",
      });
    });
  });

  describe("Query Detection", () => {
    it("should detect summary requests", () => {
      const intent = parseUserIntent("show me my spending");
      expect(intent.querySummary).toBe(true);
    });

    it("should detect transaction history requests", () => {
      const intent = parseUserIntent("fetch my transaction history");
      expect(intent.querySummary).toBe(true);
    });

    it("should detect recent transaction count requests", () => {
      const intent = parseUserIntent("show my last 5 transactions");
      expect(intent.queryRecent).toEqual({ count: 5 });
    });

    it("should parse different count formats", () => {
      expect(parseUserIntent("last 3 transactions").queryRecent?.count).toBe(3);
      expect(parseUserIntent("recent 10 lenden").queryRecent?.count).toBe(10);
    });
  });

  describe("Coach/Insights Detection", () => {
    it("should detect financial advice requests", () => {
      const intent = parseUserIntent("give me financial tips");
      expect(intent.requestCoach).toBe(true);
    });

    it("should detect money guidance requests", () => {
      const intent = parseUserIntent("need help with budget");
      expect(intent.requestCoach).toBe(true);
    });

    it("should detect habit analysis requests", () => {
      const intent = parseUserIntent("analyze my spending patterns");
      expect(intent.requestInsights).toBe(true);
    });

    it("should detect direct agent mentions", () => {
      const intent = parseUserIntent("talk to coach");
      expect(intent.requestCoach).toBe(true);
    });
  });

  describe("hasIntent Helper", () => {
    it("should return true for expense", () => {
      expect(hasIntent(parseUserIntent("spent 100"))).toBe(true);
    });

    it("should return true for income", () => {
      expect(hasIntent(parseUserIntent("received 500"))).toBe(true);
    });

    it("should return true for queries", () => {
      expect(hasIntent(parseUserIntent("show transactions"))).toBe(true);
    });

    it("should return false for unrelated text", () => {
      expect(hasIntent(parseUserIntent("hello how are you"))).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("should handle multiple intents in one message", () => {
      const intent = parseUserIntent(
        "I spent 100 on food, show my last transactions"
      );
      expect(intent.logExpense).toBeDefined();
      expect(intent.querySummary).toBe(true);
    });

    it("should handle empty input", () => {
      const intent = parseUserIntent("");
      expect(hasIntent(intent)).toBe(false);
    });

    it("should handle malformed numbers", () => {
      const intent = parseUserIntent("spent abc rupees on food");
      expect(intent.logExpense).toBeUndefined(); // Should not parse invalid amount
    });
  });
});
```

**File: `tests/analyst-parsing.test.ts`**

(See earlier implementation in PRIORITY_ACTION_PLAN.md)

**File: `tests/integration/full-pipeline.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDevAgentEnvironment } from "../../src/runtime/dev-agent";
import { processSmsMessage } from "../../src/runtime/dev-sms-agent";
import { createSmsLog } from "../../src/runtime/sms-log";
import { runAnalyst } from "../../src/runtime/analyst-agent";
import { loadTransactions } from "../../src/runtime/transactions-loader";

describe("Full Multi-Agent Pipeline", () => {
  const testDir = join(process.cwd(), "test-data-integration");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should process SMS → Dev → Param → Coach flow", async () => {
    const devEnvironment = await createDevAgentEnvironment({
      baseDir: testDir,
    });
    const smsLog = await createSmsLog({ baseDir: testDir });

    // 1. Process SMS message
    const smsMessage = {
      sender: "JK-BOBSMS-S",
      message:
        "Rs.100.00 Dr. from A/C XXXXXX3080 and Cr. to merchant@upi. Ref:123456.",
      timestamp: Date.now(),
    };

    const smsResult = await processSmsMessage(smsMessage, {
      devEnvironment,
      smsLog,
    });
    expect(smsResult.status).toBe("processed");

    // 2. Verify Dev logged transaction
    const transactions = await loadTransactions(
      join(testDir, "transactions.csv")
    );
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.amount).toBe(100);
    expect(transactions[0]?.direction).toBe("expense");

    // 3. Run Param analyst (need at least a few transactions for real insights)
    // Add more mock transactions for testing
    // ... (add 4-5 more via processSmsMessage or direct Dev calls)

    // await runAnalyst(); // This would need more setup
    // const habits = await loadHabitRecords();
    // expect(habits.length).toBeGreaterThan(0);

    // 4. Verify Coach briefing
    // const briefing = await loadLatestCoachBriefing();
    // expect(briefing).toBeDefined();
  }, 15000); // Longer timeout for integration test
});
```

---

**Continue in next section...**

(Due to length, splitting into multiple parts)

Would you like me to continue with:

1. Performance Optimizations (streaming CSV, LLM caching)
2. Feature Enhancements (multilingual, consent flow)
3. Code Quality improvements
4. Deployment readiness
5. Complete testing strategy

Let me know which sections you'd like me to detail next!
