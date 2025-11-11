# CSV to Database Migration Analysis

## Executive Summary

Current system uses CSV files for transaction logging and AI agent coordination. This analysis maps CSV-based workflows to Prisma/PostgreSQL schema for multi-user DB migration with JWT authentication.

**Key User Context:**

- User: Vighnesh (id from `users` table)
- Phone: 919619183585 (whatsapp_number)
- Age: 19, Bank Balance: 500
- API Key: [REDACTED] (sms_app_api_key)

---

## 1. Current CSV File Inventory

### 1.1 Transaction & Core Data Files

#### `data/transactions.csv`

**Purpose:** Primary transaction log written by Dev agent  
**Schema (13 columns):**

```
owner_phone, transaction_id, datetime, date, time, amount, currency,
type, target_party, description, category, is_financial, medium
```

**Readers:**

- `src/runtime/param/transactions-loader.ts` → Param agent (habit analysis)
- `src/runtime/mill/transaction-reader.ts` → Mill chatbot (query spending)
- `src/runtime/chatur/context-builder.ts` → Chatur coach (guidance)
- `src/runtime/dev/dev-agent.ts` → Dev agent (duplicate detection, seeding cache)

**Writers:**

- `src/runtime/dev/dev-agent.ts` → `DevTools.saveToDatabase()` appends rows

**DB Mapping:**

```prisma
model tranasctions {  // Note: typo in schema
  id                  String @id @db.Uuid
  owner               Int?  → references users(id)
  date_of_transaction DateTime?
  amount              Float?
  currency            String?
  type                String? → maps to "debit"/"credit"
  target_party        String?
  description         String?
  category            String?
  medium              String?
  original_sms        Int? → references sms_messages(id)
}
```

**Missing Fields in DB:**

- `datetime` (combined ISO timestamp) → use `date_of_transaction`
- `date` + `time` separate fields → merge into `date_of_transaction`
- `is_financial` boolean → all DB records implicitly financial

---

#### `data/analyst-metadata.csv`

**Purpose:** Enriched transaction data for Param analyst  
**Schema (11 columns):**

```
transaction_id, recorded_at, amount, currency, direction, category,
flavor, tags, description, event_date, event_time
```

**Readers:**

- `src/runtime/param/analyst-agent.ts` → loads for insights generation

**Writers:**

- `src/runtime/dev/dev-agent.ts` → `DevTools.sendToAnalyst()` appends rows

**DB Mapping:**
Create new table `analyst_metadata`:

```prisma
model analyst_metadata {
  id              Int      @id @default(autoincrement())
  transaction_id  String   @db.Uuid → FK to tranasctions.id
  recorded_at     DateTime
  direction       String   → "expense"|"income"|"debit"|"credit"
  flavor          String   → "necessity"|"luxury"|"treat"
  tags            String   → pipe-delimited
  owner           Int?     → FK to users(id)
}
```

---

#### `data/sms-ingest-log.csv`

**Purpose:** Audit log for SMS → transaction processing  
**Schema (30 columns):**

```
fingerprint, received_at, sender, message, timestamp, date, time,
category, score, is_financial, amount, currency, type, medium,
target_party, description, extracted_date, transaction_id,
normalized_recorded_at, normalized_event_date, normalized_event_time,
normalized_amount, normalized_currency, normalized_direction,
normalized_category, normalized_flavor, normalized_description,
normalized_summary, normalized_tags, normalized_heuristics
```

**Readers:** None (write-only audit log)

**Writers:**

- `src/runtime/dev/sms-log.ts` → `SmsLog.record()` deduplicates via fingerprint

**DB Mapping:**
Extend `sms_messages` table with audit fields:

```prisma
model sms_messages {
  // existing fields...
  fingerprint       String?  @unique
  received_at       DateTime?
  category          String?
  score             Float?
  is_financial      Boolean?
  extracted_date    String?
  normalized_data   Json?    @db.Json  // store all normalized_* fields
}
```

Or create dedicated audit table:

```prisma
model sms_ingest_log {
  id                Int      @id @default(autoincrement())
  fingerprint       String   @unique
  sms_message_id    Int?     → FK to sms_messages(id)
  transaction_id    String?  → FK to tranasctions.id
  received_at       DateTime
  normalized_data   Json     @db.Json
  owner             Int?     → FK to users(id)
}
```

---

### 1.2 AI Agent Output Files

#### `data/habits.csv`

**Purpose:** Param agent's spending habit insights  
**Schema (18 columns):**

```
habit_id, recorded_at, transaction_id, transaction_date,
transaction_amount, transaction_type, target_party, category,
spending_pattern, frequency, average_amount, total_spent,
transaction_count, habit_type, risk_level, suggestions,
recent_transactions, previous_habit_id
```

**Readers:**

- `src/runtime/chatur/coach-agent.ts` → loads for coaching briefings
- `src/runtime/mill/chatbot-session.ts` → displays to user

**Writers:**

- `src/runtime/param/analyst-agent.ts` → overwrites entire file
- `src/runtime/param/habit-tracker.ts` → appends incremental habits

**DB Mapping:**

```prisma
model habit_insights {
  id                  Int      @id @default(autoincrement())
  habit_id            String   @unique @db.Uuid
  owner               Int      → FK to users(id)
  transaction_id      String   → FK to tranasctions.id
  recorded_at         DateTime
  transaction_date    DateTime
  spending_pattern    String
  frequency           String
  average_amount      Float
  total_spent         Float
  transaction_count   Int
  habit_type          String   → "recurring"|"one-time"|etc
  risk_level          String   → "low"|"moderate"|"high"
  suggestions         String
  recent_transactions String   → pipe-delimited IDs
  previous_habit_id   String?  → FK to habit_insights.habit_id
}
```

---

#### `data/coach-briefings.json`

**Purpose:** Chatur coach's financial guidance messages  
**Schema:**

```json
[{
  "id": "uuid",
  "createdAt": "ISO timestamp",
  "headline": "string",
  "counsel": "string",
  "evidence": "string",
  "insightHash": "sha256",
  "trigger": "analyst"|"manual"
}]
```

**Readers:**

- `src/runtime/mill/chatbot-session.ts` → displays latest briefing
- `src/runtime/chatur/coach-agent.ts` → loads for deduplication

**Writers:**

- `src/runtime/chatur/coach-agent.ts` → appends new briefings

**DB Mapping:**

```prisma
model coach_briefings {
  id           String   @id @db.Uuid
  owner        Int      → FK to users(id)
  created_at   DateTime @default(now())
  headline     String
  counsel      String
  evidence     String
  insight_hash String
  trigger      String   → "analyst"|"manual"
  delivered    Boolean  @default(false)
  delivered_at DateTime?
}
```

---

#### `data/habit-snapshots/*.json`

**Purpose:** Versioned habit analysis snapshots (by hash)  
**Schema:**

```json
{
  "snapshotId": "sha256",
  "createdAt": "ISO timestamp",
  "transactionId": "uuid",
  "ownerPhone": "string",
  "contextTransactions": [...],
  "contextHabits": [...],
  "totalDebits": 0,
  "totalCredits": 0,
  "topCategories": [...],
  "behaviorSummary": "string",
  "recommendations": [...]
}
```

**Readers:**

- `src/runtime/chatur/context-builder.ts` → loads for coaching context

**Writers:**

- `src/runtime/param/habit-tracker.ts` → writes JSON files

**DB Mapping:**

```prisma
model habit_snapshots {
  id                   Int      @id @default(autoincrement())
  snapshot_id          String   @unique
  owner                Int      → FK to users(id)
  transaction_id       String   → FK to tranasctions.id
  created_at           DateTime
  context_data         Json     @db.Json  // contextTransactions, contextHabits
  summary_data         Json     @db.Json  // totals, categories, behavior
}
```

---

### 1.3 Alert & Anomaly Detection Files

#### `data/alerts.json`

**Purpose:** Transaction anomaly alerts from Dev agent  
**Schema:**

```json
[{
  "id": "uuid",
  "transactionId": "uuid",
  "createdAt": "ISO timestamp",
  "rule": "repeat_payee|rapid_burst|...",
  "severity": "low|medium|high",
  "confidence": 0.8,
  "summary": "string",
  "details": {...},
  "status": "open|acknowledged|dismissed"
}]
```

**Readers:**

- `src/runtime/mill/chatbot-session.ts` → displays alerts to user
- `src/runtime/dev/alert-manager.ts` → loads for updates

**Writers:**

- `src/runtime/dev/alert-manager.ts` → appends/updates alerts

**DB Mapping:**

```prisma
model alerts {
  id              String   @id @db.Uuid
  owner           Int      → FK to users(id)
  transaction_id  String   → FK to tranasctions.id
  created_at      DateTime @default(now())
  rule            String
  severity        String
  confidence      Float
  summary         String
  details         Json?    @db.Json
  status          String   @default("open")
  acknowledged_at DateTime?
  acknowledged_by String?
}
```

---

#### `data/alert-metrics.json`

**Purpose:** Rolling metrics for anomaly detection  
**Schema:**

```json
{
  "recentTransactions": [...],
  "incomeSamples": [...]
}
```

**Readers:**

- `src/runtime/dev/alert-manager.ts` → loads for anomaly detection

**Writers:**

- `src/runtime/dev/alert-manager.ts` → updates after each transaction

**DB Mapping:**
Store in memory or cache (Redis) for performance; optionally persist:

```prisma
model alert_metrics {
  id         Int      @id @default(autoincrement())
  owner      Int      @unique → FK to users(id)
  updated_at DateTime @default(now())
  metrics    Json     @db.Json
}
```

---

## 2. Agent Runtime Workflows

### 2.1 Mill Chatbot (User-Facing Agent)

**Files Read:**

- `transactions.csv` → via `transaction-reader.ts`
- `habits.csv` → via `loadHabitRecords()`
- `coach-briefings.json` → via `loadLatestCoachBriefing()`

**Files Written:** None (delegates to Dev agent)

**API Requirements:**

```typescript
// JWT middleware extracts userId from token
GET  /api/mill/transactions?userId={from JWT}
GET  /api/mill/habits?userId={from JWT}
GET  /api/mill/briefings/latest?userId={from JWT}
POST /api/mill/log-transaction  // delegates to Dev API
```

**DB Queries:**

```sql
-- Transaction summary
SELECT * FROM tranasctions WHERE owner = $userId ORDER BY date_of_transaction DESC LIMIT 10;

-- Spending totals
SELECT
  SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END) AS total_expense,
  SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END) AS total_income
FROM tranasctions WHERE owner = $userId;

-- Habits
SELECT * FROM habit_insights WHERE owner = $userId ORDER BY recorded_at DESC LIMIT 5;

-- Latest briefing
SELECT * FROM coach_briefings WHERE owner = $userId ORDER BY created_at DESC LIMIT 1;
```

---

### 2.2 Dev Agent (Transaction Logger)

**Files Read:**

- `transactions.csv` → for duplicate detection cache seeding

**Files Written:**

- `transactions.csv` → appends new transactions
- `analyst-metadata.csv` → appends enriched metadata
- `sms-ingest-log.csv` → appends SMS audit log
- `alerts.json` → appends anomaly alerts
- `alert-metrics.json` → updates metrics

**API Requirements:**

```typescript
POST /api/dev/transactions  // requires userId in JWT
  body: { amount, description, category, direction, raw_text }

POST /api/dev/sms/ingest    // requires userId + sms_app_api_key
  body: { sender, message, timestamp, ... }

GET  /api/dev/alerts?userId={from JWT}
PATCH /api/dev/alerts/:id/status  // acknowledge/dismiss
```

**DB Queries:**

```sql
-- Insert transaction
INSERT INTO tranasctions (id, owner, amount, type, target_party, description, category, medium, date_of_transaction)
VALUES ($id, $userId, $amount, $type, $target, $desc, $category, $medium, $datetime);

-- Insert metadata
INSERT INTO analyst_metadata (transaction_id, owner, recorded_at, direction, flavor, tags)
VALUES ($txId, $userId, $recordedAt, $direction, $flavor, $tags);

-- Duplicate check
SELECT * FROM tranasctions
WHERE owner = $userId
  AND amount = $amount
  AND date_of_transaction BETWEEN $start AND $end
  AND description ILIKE '%' || $keyword || '%';

-- Insert alert
INSERT INTO alerts (id, owner, transaction_id, rule, severity, confidence, summary, details)
VALUES ($id, $userId, $txId, $rule, $severity, $confidence, $summary, $details);
```

---

### 2.3 Param Analyst (Habit Tracker)

**Files Read:**

- `transactions.csv` → loads all transactions for analysis
- `habits.csv` → loads previous habits for context

**Files Written:**

- `habits.csv` → overwrites with new insights
- `habit-snapshots/*.json` → writes versioned snapshots

**API Requirements:**

```typescript
POST /api/param/analyze  // triggered by new transaction or manual
  query: ?userId={from JWT}

GET  /api/param/habits?userId={from JWT}
GET  /api/param/snapshots/:hash?userId={from JWT}
```

**DB Queries:**

```sql
-- Load transactions for analysis
SELECT * FROM tranasctions WHERE owner = $userId ORDER BY date_of_transaction DESC LIMIT 100;

-- Load previous habits
SELECT * FROM habit_insights WHERE owner = $userId ORDER BY recorded_at DESC LIMIT 5;

-- Insert new habit
INSERT INTO habit_insights (habit_id, owner, transaction_id, ...)
VALUES ($habitId, $userId, $txId, ...);

-- Insert snapshot
INSERT INTO habit_snapshots (snapshot_id, owner, transaction_id, created_at, context_data, summary_data)
VALUES ($snapshotId, $userId, $txId, $createdAt, $context, $summary);
```

---

### 2.4 Chatur Coach (Financial Advisor)

**Files Read:**

- `habits.csv` → loads latest insights
- `coach-briefings.json` → loads previous briefings for dedup
- `habit-snapshots/*.json` → loads context for coaching

**Files Written:**

- `coach-briefings.json` → appends new briefings

**API Requirements:**

```typescript
POST /api/chatur/brief  // auto-triggered by Param or manual query
  query: ?userId={from JWT}
  body: { question?: string }

GET  /api/chatur/briefings?userId={from JWT}&limit=10
PATCH /api/chatur/briefings/:id/deliver  // mark as sent to user
```

**DB Queries:**

```sql
-- Load habits for briefing
SELECT * FROM habit_insights WHERE owner = $userId ORDER BY recorded_at DESC;

-- Check for duplicate briefing
SELECT * FROM coach_briefings
WHERE owner = $userId AND insight_hash = $hash
ORDER BY created_at DESC LIMIT 1;

-- Insert briefing
INSERT INTO coach_briefings (id, owner, headline, counsel, evidence, insight_hash, trigger)
VALUES ($id, $userId, $headline, $counsel, $evidence, $hash, $trigger);

-- Load snapshots
SELECT * FROM habit_snapshots WHERE owner = $userId ORDER BY created_at DESC LIMIT 5;
```

---

## 3. Schema Gaps & Additions Needed

### 3.1 Missing Tables (CSV → DB)

```prisma
// NEW: Analyst enrichment data
model analyst_metadata {
  id              Int      @id @default(autoincrement())
  transaction_id  String   @db.Uuid
  owner           Int
  recorded_at     DateTime @default(now())
  direction       String   @db.VarChar(50)
  flavor          String   @db.VarChar(50)
  tags            String?  // pipe-delimited

  tranasctions    tranasctions @relation(fields: [transaction_id], references: [id], onDelete: Cascade)
  users           users        @relation(fields: [owner], references: [id], onDelete: Cascade)

  @@index([owner, recorded_at])
}

// NEW: Param habit insights
model habit_insights {
  id                  Int      @id @default(autoincrement())
  habit_id            String   @unique @db.Uuid
  owner               Int
  transaction_id      String   @db.Uuid
  recorded_at         DateTime @default(now())
  transaction_date    DateTime
  transaction_amount  Float
  transaction_type    String   @db.VarChar(50)
  target_party        String?  @db.VarChar(255)
  category            String?  @db.VarChar(255)
  spending_pattern    String
  frequency           String   @db.VarChar(100)
  average_amount      Float
  total_spent         Float
  transaction_count   Int
  habit_type          String   @db.VarChar(100)
  risk_level          String   @db.VarChar(50)
  suggestions         String
  recent_transactions String?  // pipe-delimited IDs
  previous_habit_id   String?  @db.Uuid

  tranasctions        tranasctions @relation(fields: [transaction_id], references: [id], onDelete: Cascade)
  users               users        @relation(fields: [owner], references: [id], onDelete: Cascade)

  @@index([owner, recorded_at])
  @@index([habit_id])
}

// NEW: Coach briefings
model coach_briefings {
  id            String   @id @db.Uuid
  owner         Int
  created_at    DateTime @default(now())
  headline      String   @db.VarChar(500)
  counsel       String
  evidence      String
  insight_hash  String   @db.VarChar(64)
  trigger       String   @db.VarChar(50)
  delivered     Boolean  @default(false)
  delivered_at  DateTime?

  users         users    @relation(fields: [owner], references: [id], onDelete: Cascade)

  @@index([owner, created_at])
  @@index([insight_hash])
}

// NEW: Habit snapshots
model habit_snapshots {
  id              Int      @id @default(autoincrement())
  snapshot_id     String   @unique @db.VarChar(64)
  owner           Int
  transaction_id  String   @db.Uuid
  created_at      DateTime @default(now())
  context_data    Json     @db.Json
  summary_data    Json     @db.Json

  tranasctions    tranasctions @relation(fields: [transaction_id], references: [id], onDelete: Cascade)
  users           users        @relation(fields: [owner], references: [id], onDelete: Cascade)

  @@index([owner, created_at])
  @@index([snapshot_id])
}

// NEW: Transaction alerts
model alerts {
  id               String    @id @db.Uuid
  owner            Int
  transaction_id   String    @db.Uuid
  created_at       DateTime  @default(now())
  rule             String    @db.VarChar(100)
  severity         String    @db.VarChar(50)
  confidence       Float
  summary          String
  details          Json?     @db.Json
  status           String    @default("open") @db.VarChar(50)
  acknowledged_at  DateTime?
  acknowledged_by  String?   @db.VarChar(255)

  tranasctions     tranasctions @relation(fields: [transaction_id], references: [id], onDelete: Cascade)
  users            users        @relation(fields: [owner], references: [id], onDelete: Cascade)

  @@index([owner, status, created_at])
}

// OPTIONAL: SMS ingest audit
model sms_ingest_log {
  id               Int      @id @default(autoincrement())
  fingerprint      String   @unique @db.VarChar(64)
  owner            Int
  sms_message_id   Int?
  transaction_id   String?  @db.Uuid
  received_at      DateTime @default(now())
  normalized_data  Json     @db.Json

  sms_messages     sms_messages? @relation(fields: [sms_message_id], references: [id], onDelete: SetNull)
  tranasctions     tranasctions? @relation(fields: [transaction_id], references: [id], onDelete: SetNull)
  users            users         @relation(fields: [owner], references: [id], onDelete: Cascade)

  @@index([owner, received_at])
  @@index([fingerprint])
}

// OPTIONAL: Alert metrics cache
model alert_metrics {
  id         Int      @id @default(autoincrement())
  owner      Int      @unique
  updated_at DateTime @default(now())
  metrics    Json     @db.Json

  users      users    @relation(fields: [owner], references: [id], onDelete: Cascade)
}
```

### 3.2 Existing Table Enhancements

```prisma
// EXTEND: sms_messages (add audit fields)
model sms_messages {
  // existing fields...
  fingerprint       String?   @unique @db.VarChar(64)
  received_at       DateTime? @db.Timestamptz(6)
  category          String?   @db.VarChar(255)
  score             Float?
  is_financial      Boolean?
  extracted_date    String?   @db.VarChar(50)
  normalized_data   Json?     @db.Json

  sms_ingest_log    sms_ingest_log[]  // reverse relation
}

// EXTEND: tranasctions (add indexed fields)
model tranasctions {
  // existing fields...

  // Add missing relations
  analyst_metadata  analyst_metadata[]
  habit_insights    habit_insights[]
  habit_snapshots   habit_snapshots[]
  alerts            alerts[]
  sms_ingest_log    sms_ingest_log[]

  @@index([owner, date_of_transaction])
  @@index([status, owner])
}

// EXTEND: users (add new relations)
model users {
  // existing fields...

  analyst_metadata  analyst_metadata[]
  habit_insights    habit_insights[]
  coach_briefings   coach_briefings[]
  habit_snapshots   habit_snapshots[]
  alerts            alerts[]
  sms_ingest_log    sms_ingest_log[]
  alert_metrics     alert_metrics?
}
```

---

## 4. JWT Authentication & Multi-User Constraints

### 4.1 JWT Payload Structure

```typescript
interface JWTPayload {
  sub: string; // User ID (users.id as string)
  phone: string; // users.whatsapp_number
  name: string; // users.name
  role: string; // "user"|"admin"|"analyst"
  permissions: string[]; // ["transactions:read", "habits:write", ...]
  iat: number;
  exp: number;
}
```

### 4.2 Middleware Flow

```typescript
// web/middleware.ts (already exists)
export async function middleware(request: NextRequest) {
  const token = getTokenFromRequest(request);
  if (!token) return unauthorizedResponse();

  const payload = await verifyAuthToken(token);
  if (!payload) return unauthorizedResponse();

  // Inject user context into headers for API routes
  request.headers.set("x-user-id", payload.sub);
  request.headers.set("x-user-phone", payload.phone);
  request.headers.set("x-user-role", payload.role);

  return NextResponse.next({ request });
}
```

### 4.3 API Route User Extraction

```typescript
// Every API route must:
export async function GET(request: NextRequest) {
  const userId = parseInt(request.headers.get("x-user-id")!);
  const userPhone = request.headers.get("x-user-phone")!;

  // All DB queries MUST filter by userId
  const transactions = await prisma.tranasctions.findMany({
    where: { owner: userId },
    orderBy: { date_of_transaction: "desc" },
  });

  return NextResponse.json({ transactions });
}
```

### 4.4 Row-Level Security Constraints

**Every query MUST include `where: { owner: userId }`:**

```typescript
// ✅ CORRECT
prisma.tranasctions.findMany({ where: { owner: userId } });
prisma.habit_insights.findMany({ where: { owner: userId } });

// ❌ WRONG (allows cross-user data leakage)
prisma.tranasctions.findMany();
prisma.habit_insights.findFirst({ where: { habit_id: someId } });
```

---

## 5. API Endpoint Design (Multi-User)

### 5.1 Transaction APIs (`/api/transactions`)

```typescript
// POST /api/transactions
POST /api/transactions
  Headers: Authorization: Bearer {JWT}
  Body: {
    amount: number,
    description: string,
    category_suggestion: string,
    direction: "expense"|"income",
    raw_text: string,
    target_party?: string,
    medium?: string
  }
  → Calls Dev pipeline with userId from JWT
  → Returns: { status: "logged", transaction: {...}, alerts?: [...] }

// GET /api/transactions
GET /api/transactions?limit=10&startDate=2025-01-01
  Headers: Authorization: Bearer {JWT}
  → Queries: tranasctions WHERE owner = userId
  → Returns: { transactions: [...], total: number }

// GET /api/transactions/:id
GET /api/transactions/{uuid}
  → Verify: tranasctions.owner = userId before returning
```

### 5.2 Habits API (`/api/habits`)

```typescript
// POST /api/habits/analyze
POST /api/habits/analyze
  Headers: Authorization: Bearer {JWT}
  → Triggers Param analyst for userId
  → Returns: { insights: [...] }

// GET /api/habits
GET /api/habits?limit=5
  → Queries: habit_insights WHERE owner = userId
  → Returns: { habits: [...] }

// GET /api/habits/snapshots/:hash
GET /api/habits/snapshots/{hash}
  → Queries: habit_snapshots WHERE owner = userId AND snapshot_id = hash
  → Returns: { snapshot: {...} }
```

### 5.3 Briefings API (`/api/briefings`)

```typescript
// POST /api/briefings
POST /api/briefings
  Headers: Authorization: Bearer {JWT}
  Body: { question?: string }
  → Triggers Chatur coach for userId
  → Returns: { briefing: {...} }

// GET /api/briefings
GET /api/briefings?limit=10
  → Queries: coach_briefings WHERE owner = userId
  → Returns: { briefings: [...] }

// PATCH /api/briefings/:id/deliver
PATCH /api/briefings/{uuid}/deliver
  → Updates: coach_briefings SET delivered = true WHERE id = uuid AND owner = userId
```

### 5.4 Alerts API (`/api/alerts`)

```typescript
// GET /api/alerts
GET /api/alerts?status=open
  → Queries: alerts WHERE owner = userId AND status = status
  → Returns: { alerts: [...] }

// PATCH /api/alerts/:id/status
PATCH /api/alerts/{uuid}/status
  Body: { status: "acknowledged"|"dismissed", actor?: string }
  → Updates: alerts WHERE id = uuid AND owner = userId
```

### 5.5 SMS Ingestion API (`/api/sms/ingest`)

```typescript
// POST /api/sms/ingest
POST /api/sms/ingest
  Headers:
    Authorization: Bearer {JWT}
    X-SMS-API-Key: {users.sms_app_api_key}
  Body: {
    sender: string,
    message: string,
    timestamp: string,
    date?: string,
    time?: string
  }
  → Verifies: users.sms_app_api_key = header value
  → Processes SMS → transaction
  → Returns: { status: "processed", transaction: {...} }
```

---

## 6. Data Migration Strategy

### 6.1 CSV → DB Seed Script

```typescript
// scripts/seed-db-from-csv.ts
import { PrismaClient } from "../data/generated/prisma";
import { readFile } from "fs/promises";
import { parse } from "csv-parse/sync";

const prisma = new PrismaClient();

async function seedTransactions() {
  const csv = await readFile("data/transactions.csv", "utf8");
  const rows = parse(csv, { columns: true, skip_empty_lines: true });

  for (const row of rows) {
    // Map owner_phone to users.id
    const user = await prisma.users.findFirst({
      where: { whatsapp_number: row.owner_phone.replace("+", "") },
    });

    if (!user) {
      console.warn(`User not found for phone: ${row.owner_phone}`);
      continue;
    }

    await prisma.tranasctions.create({
      data: {
        id: row.transaction_id,
        owner: user.id,
        date_of_transaction: new Date(row.datetime),
        amount: parseFloat(row.amount),
        currency: row.currency,
        type: row.type,
        target_party: row.target_party,
        description: row.description,
        category: row.category,
        medium: row.medium,
        status: "active",
      },
    });
  }
}

async function seedHabits() {
  const csv = await readFile("data/habits.csv", "utf8");
  const rows = parse(csv, { columns: true, skip_empty_lines: true });

  for (const row of rows) {
    const tx = await prisma.tranasctions.findUnique({
      where: { id: row.transaction_id },
    });

    if (!tx) continue;

    await prisma.habit_insights.create({
      data: {
        habit_id: row.habit_id,
        owner: tx.owner,
        transaction_id: row.transaction_id,
        recorded_at: new Date(row.recorded_at),
        transaction_date: new Date(row.transaction_date),
        transaction_amount: parseFloat(row.transaction_amount),
        transaction_type: row.transaction_type,
        target_party: row.target_party,
        category: row.category,
        spending_pattern: row.spending_pattern,
        frequency: row.frequency,
        average_amount: parseFloat(row.average_amount),
        total_spent: parseFloat(row.total_spent),
        transaction_count: parseInt(row.transaction_count),
        habit_type: row.habit_type,
        risk_level: row.risk_level,
        suggestions: row.suggestions,
        recent_transactions: row.recent_transactions,
        previous_habit_id: row.previous_habit_id || null,
      },
    });
  }
}

seedTransactions().then(seedHabits).catch(console.error);
```

### 6.2 Dual-Write Transition Period

```typescript
// During migration, write to BOTH CSV and DB
async function saveTransaction(tx: Transaction, userId: number) {
  // Legacy CSV write
  await appendFile("data/transactions.csv", buildCsvRow(tx));

  // New DB write
  await prisma.tranasctions.create({
    data: { ...tx, owner: userId },
  });
}

// Switch reads to DB first, fallback to CSV
async function loadTransactions(userId: number) {
  const dbTxs = await prisma.tranasctions.findMany({
    where: { owner: userId },
  });
  if (dbTxs.length > 0) return dbTxs;

  // Fallback to CSV (deprecated)
  return loadFromCsv();
}
```

---

## 7. Implementation Checklist

### Phase 1: Schema Extension

- [ ] Add new Prisma models (analyst_metadata, habit_insights, coach_briefings, habit_snapshots, alerts)
- [ ] Extend existing models (sms_messages, tranasctions, users) with new fields/relations
- [ ] Run `npx prisma migrate dev --name add_ai_agent_tables`
- [ ] Regenerate Prisma client: `npx prisma generate`

### Phase 2: Data Migration

- [ ] Create seed script to import CSVs → DB
- [ ] Map phone numbers to user IDs (ensure Vighnesh = 919619183585)
- [ ] Migrate transactions, habits, briefings, alerts
- [ ] Verify data integrity (counts, foreign keys)

### Phase 3: API Development

- [ ] Implement transaction APIs (POST /api/transactions, GET /api/transactions)
- [ ] Implement habit APIs (POST /api/habits/analyze, GET /api/habits)
- [ ] Implement briefing APIs (POST /api/briefings, GET /api/briefings)
- [ ] Implement alert APIs (GET /api/alerts, PATCH /api/alerts/:id)
- [ ] Implement SMS ingest API (POST /api/sms/ingest)

### Phase 4: Runtime Integration

- [ ] Refactor Dev agent to use Prisma instead of CSV writes
- [ ] Refactor Param analyst to read from DB instead of CSV
- [ ] Refactor Chatur coach to read from DB instead of JSON files
- [ ] Refactor Mill chatbot to query DB APIs instead of reading CSVs
- [ ] Update duplicate detection to use DB queries

### Phase 5: Authentication & Security

- [ ] Enforce JWT middleware on all `/api/*` routes
- [ ] Add user ID extraction from JWT to every API route
- [ ] Add `where: { owner: userId }` to EVERY DB query
- [ ] Test cross-user data isolation (user A cannot see user B's data)
- [ ] Validate SMS API key for `/api/sms/ingest`

### Phase 6: Testing & Validation

- [ ] Unit tests for each API endpoint
- [ ] Integration tests for agent workflows
- [ ] Load test with multiple concurrent users
- [ ] Verify CSV fallback during dual-write period
- [ ] Test JWT expiration/refresh flows

### Phase 7: Cutover

- [ ] Deploy DB-backed APIs to production
- [ ] Monitor error rates and performance
- [ ] Disable CSV writes after 1 week of stable DB operation
- [ ] Archive CSV files as backups
- [ ] Update agent documentation to reflect DB-first architecture

---

## 8. Key Constraints & Gotchas

### 8.1 User ID Propagation

**CRITICAL:** Every API call must extract `userId` from JWT and pass to all queries. Missing this causes data leakage.

### 8.2 Phone Number Mapping

CSV uses phone strings (`+919619183585`), DB uses integer user IDs. Ensure consistent mapping:

```typescript
const user = await prisma.users.findFirst({
  where: { whatsapp_number: phoneString.replace(/\+/g, "") },
});
```

### 8.3 Transaction Typo

Schema has `tranasctions` (typo). Either:

- Live with it and use `@@map("transactions")` in Prisma
- Run migration to rename table (risky in production)

### 8.4 SMS API Key Storage

Current schema stores `sms_app_api_key` as JSON. For Vighnesh:

```json
{ "key": "[REDACTED]" }
```

API must parse this JSON field or migrate to `String` type.

### 8.5 CSV Field Mappings

| CSV Field        | DB Field                | Notes                    |
| ---------------- | ----------------------- | ------------------------ |
| `owner_phone`    | `users.whatsapp_number` | Lookup required          |
| `transaction_id` | `tranasctions.id`       | UUID match               |
| `datetime`       | `date_of_transaction`   | ISO timestamp            |
| `type`           | `type`                  | "debit"/"credit"         |
| `is_financial`   | (implicit)              | All DB records financial |

### 8.6 Habit Snapshot Hash Collisions

Snapshots use SHA256 hash as ID. Ensure uniqueness constraint and handle rare collisions gracefully.

### 8.7 Alert Manager State

Currently stores metrics in JSON file. For multi-user, must partition by `userId` in DB or cache.

---

## 9. Performance Considerations

### 9.1 Indexes

```sql
-- CRITICAL indexes for multi-user queries
CREATE INDEX idx_transactions_owner_date ON tranasctions(owner, date_of_transaction DESC);
CREATE INDEX idx_habits_owner_recorded ON habit_insights(owner, recorded_at DESC);
CREATE INDEX idx_briefings_owner_created ON coach_briefings(owner, created_at DESC);
CREATE INDEX idx_alerts_owner_status ON alerts(owner, status, created_at DESC);
```

### 9.2 Query Optimization

```typescript
// ✅ Use select to limit fields
prisma.tranasctions.findMany({
  where: { owner: userId },
  select: { id: true, amount: true, description: true },
  take: 10,
});

// ✅ Use cursor pagination for large datasets
prisma.tranasctions.findMany({
  where: { owner: userId },
  take: 20,
  skip: 1,
  cursor: { id: lastId },
});
```

### 9.3 Caching Strategy

- Use Redis for alert metrics (hot data)
- Cache latest briefing per user (TTL 5 min)
- Cache transaction summaries (invalidate on new tx)

---

## 10. Next Steps

1. **Immediate:** Run Prisma migration to add new tables
2. **Week 1:** Implement transaction APIs + Dev agent DB writes
3. **Week 2:** Migrate Param/Chatur to DB reads, dual-write CSVs
4. **Week 3:** Full DB cutover, deprecate CSV operations
5. **Week 4:** Performance tuning, monitoring, documentation

---

**Status:** Analysis complete. Ready for schema migration and API implementation.
