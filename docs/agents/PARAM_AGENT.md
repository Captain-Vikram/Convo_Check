# Param - The Financial Analyst 📊

## Agent Identity

**Agent ID**: `param` (agent3)  
**Display Name**: Param  
**Role**: Analytical Insights & Pattern Detection Specialist  
**Personality**: Data-driven, precise, observant storyteller

---

## Character Essence

Param is the **analytical brain** of the financial system. Param:

- **Observant**: Spots patterns humans miss
- **Precise**: Every insight backed by exact numbers
- **Concise**: No fluff, pure actionable intelligence
- **Non-Judgmental**: Reports facts, not opinions
- **Evidence-Based**: Never speculates beyond data

### Key Trait

Param is like a **financial detective** - examines every transaction, identifies patterns, and presents findings as clear, actionable bullets that coaches can use verbatim.

## What's New in the Unified Runtime (Nov 2025)

- **Versioned analysis runs** – `runAnalyst` still tracks an `ANALYSIS_VERSION` per transaction and skips work when the stored `analyzed_version` already matches, so nightly jobs stay fast while still allowing forced replays.
  - Transactions are marked with `analyzed_at` timestamp and `analyzed_version` integer via PATCH `/api/transactions/:id`
  - Dry-run mode (`dryRun: true`) reports impact without writing changes
  - Force re-analysis with `reanalyzeAll: true` to bypass version checks
- **Direct API persistence** – Insights are written through `syncHabitToApi` and transactions are patched via `/api/transactions/:id`, meaning the docs + dashboards always reflect the latest evidence without manual exports.
  - Uses `HabitInsight` typed interface: `{ habitLabel, evidence, counsel, fullText }`
  - Multi-user support via optional `ownerId` parameter
- **Incremental insight reuse (NEW)** – Param no longer wipes the slate every run. Matching habits (case-insensitive labels) are updated in place, unmatched ones are marked `superseded`, and only truly new bullets get new IDs.
- **Database-backed snapshots (NEW)** – Every run upserts a structured record into `habit_snapshots` with `context_data`, `summary_data`, and a deterministic `snapshot_id` hash so Chatur can reload the full context without touching JSON files.
- **Daily freshness + rate limiting (NEW)** – Param records `last_run_at` inside `habit_processing_cursors` and uses `PARAM_MAX_RUNS_PER_DAY` / `PARAM_RATE_LIMIT_HOURS` to skip redundant runs, while Chatur can still force a replay when the cursor is >24h old or when manual triggers fire.
- **Automatic coach handoff** – After every successful analysis, the agent calls `runCoach` with the latest/previous insights (passed from `loadExistingInsights`), keeping Chatur's playbook in sync without separate schedulers.
  - Trigger reason recorded as `"analyst"` in coach session metadata
  - Continues even if coach handoff fails (non-blocking error handling)

**Why it's better**: Param now produces "ready-to-serve" insights that stay versioned, deduped, and instantly available to Chatur/Mill. Version tracking eliminates redundant analysis, and automatic coach handoff creates a tight feedback loop.

---

## Implementation Details (Nov 2025)

### Runtime Flow: `runAnalyst(options)`

**Entry Point**: `src/runtime/param/analyst-agent.ts`

The `runAnalyst` function orchestrates the entire analysis pipeline:

```typescript
export interface RunAnalystOptions {
  reanalyzeAll?: boolean; // Force re-analysis regardless of analyzed_version
  dryRun?: boolean; // Count only, no writes
  ownerId?: number; // Optional multi-user filter
}

export interface AnalystRunResult {
  status: "success" | "skipped" | "error";
  totalTransactions: number;
  analyzedTransactions: number;
  insightsGenerated: number;
  message: string;
  error?: Error;
}
```

**Step 1: Load & Filter Transactions**

```
loadTransactions()
  → All transactions from database (via NormalizedTransaction format)
  → If reanalyzeAll=false: filter to transactions where analyzed_version !== ANALYSIS_VERSION
  → If 0 transactions: return placeholder insight, skip analysis
```

**Step 2: Build Statistics**

```
buildAnalysisStats(transactionsToAnalyze)
  → CategoryStat: top categories by count & spend
  → DirectionStat: income vs expense totals
  → WeekdayStat: spending distribution by day of week
  → TagStat: custom tags frequency
  → FlavorStat: transaction flavor distribution
  → CounterpartyStat: merchant/payee distribution
  → Last 30-day metrics: transaction count, savings rate
  → Largest & recent transactions (top 5 each)
  → Returns: AnalysisStats object (30+ fields)
```

**Step 3: Generate LLM Prompt**

```
buildAnalystPrompt(stats)
  → Includes lifetime totals, last 30-day summary, guidance rules
  → Embeds full AnalysisStats JSON payload
  → Instructs LLM on Insight Protocol
  → Example format: "- Habit Label | Evidence: ... | Counsel: ..."
```

**Step 4: Call Language Model (Gemini)**

```
callLanguageModel(prompt)
  → Uses callLLM("agent3", { system, messages })
  → System prompt enforces mandatory insight protocol
  → Returns raw bullet lines (5-7 expected)
```

**Step 5: Parse Bullet Lines**

```
normalizeBulletLines(rawOutput)
  → Split on newlines, filter empty lines
  → Ensure each line starts with "- "

parseHabitInsight(line)
  → Attempts 3 parsing strategies:
    1. Structured Fields: "Habit Label: X | Evidence: Y | Counsel: Z"
    2. Label-Counsel: "Pattern: evidence; Counsel: action"
    3. Simple: "Label: evidence; Counsel: action"
  → Extracts { habitLabel, evidence, counsel, fullText }
  → Throws if no valid structure detected
```

**Step 6: Persist Insights Incrementally**

```
persistInsightsToDatabase(insights, previousInsights)
  → Build case-insensitive map of current active habits
  → If label matches: UPDATE in place (keep habit_id, mark superseded=false)
  → If no match: CREATE new habit_id (UUID) with recorded_at/updated_at timestamps
  → Remaining unmatched previous entries are marked superseded=true
```

Key outcomes:

- Eliminates churn by reusing `habit_id` for long-lived habits
- Only emits `superseded` entries for habits that truly disappeared
- Returns `{ created, updated, superseded }` so downstream systems know what changed

**Step 7: Persist Habit Snapshot**

```
persistHabitSnapshot({ ownerId, stats, insights, transactions, trigger })
  → Build summary payload (totals, categories, savings rate)
  → Capture context: last 25 tx, latest + previous insights
  → Hash canonical payload → deterministic snapshot_id & snapshot_hash
  → UPSERT into habit_snapshots with context_data + summary_data JSON blobs
```

Snapshots now live entirely in PostgreSQL (no `/data/generated` JSON files) and are keyed by a repeatable hash, so Chatur can reload the exact metrics set that produced a briefing.

**Step 8: Mark Transactions Analyzed**

```
markTransactionsAsAnalyzed(transactionsToAnalyze, ANALYSIS_VERSION)
  → For each transaction:
    - PATCH /api/transactions/:id with { analyzed_at, analyzed_version, analysis_notes }
    - Tracked fields: analyzed_at (ISO timestamp), analyzed_version (int), analysis_notes (string)
    - Non-blocking: continues if one fails
```

**Step 9: Hand Off to Coach (if successful)**

```
runCoach({ latestInsights, previousInsights, trigger: "analyst" })
  → Calls src/runtime/chatur/coach-agent.ts
  → Passes fresh insights + previous snapshot for continuity
  → Non-blocking: catches and logs errors without failing main flow
```

---

### Database Schema (Prisma)

**Tables Used**:

#### 1. `habit_insights`

Stores analyzed spending habits and patterns. Schema:

```prisma
model habit_insights {
  id                  String    @id @db.Uuid
  owner               Int                    // User ID
  habit_label         String    @db.VarChar(255)    // Pattern name
  evidence            String                 // Quantified data (e.g., "₹8K spent")
  counsel             String                 // Actionable recommendation
  full_text           String                 // Complete bullet line
  status              String    @default("published") @db.VarChar(64)
  recorded_at         DateTime  @default(now()) @db.Timestamptz(6)
  source_agent        String    @default("param") @db.VarChar(64)

  @@index([owner, status, recorded_at])
}
```

**Key Queries**:

- `findMany({ where: { owner, status: "published" }, orderBy: { recorded_at: "desc" }, take: 5 })`
  → Fetches 5 most recent insights per user (used by Mill/Chatur)

#### 2. `habit_snapshots`

Stores historical snapshots for trend tracking. Schema:

```prisma
model habit_snapshots {
  id              Int      @id @default(autoincrement())
  owner           Int
  snapshot_date   DateTime @db.Timestamptz(6)
  insights_count  Int
  top_categories  Json     // Array of category statistics
  metadata        Json     // Additional context

  @@index([owner, snapshot_date])
}
```

**Usage**: Referenced by coach_briefings for historical context.

#### 3. `tranasctions`

Stores individual financial transactions. Schema:

```prisma
model tranasctions {
  id                  String    @id @db.Uuid
  owner               Int                    // User ID
  type                String    @db.VarChar(64)    // "income", "expense"
  category            String    @db.VarChar(255)   // Spending category
  amount              Decimal   @db.Decimal(15, 2)
  date_of_transaction DateTime  @db.Timestamptz(6)
  description         String?
  status              String    @default("published") @db.VarChar(64)

  // Analysis tracking (NEW in v1.1)
  analyzed_at         DateTime? @db.Timestamptz(6)  // When Param analyzed this
  analyzed_version    Int?                         // Analysis version (ANALYSIS_VERSION=1)
  analysis_notes      String?                      // e.g., "Analyzed by param agent v1"

  @@index([owner, status, date_of_transaction])
  @@index([owner, analyzed_version])  // For version filtering
}
```

**Key Queries**:

- `findMany({ where: { owner, status: "published" } })`
  → Load all transactions for analysis
- `findMany({ where: { owner, analyzed_version: { not: 1 } } })`
  → Find unanalyzed transactions (for incremental runs)

#### 4. `coach_briefings`

Stores generated coaching messages. Param populates indirectly via Coach handoff. Schema:

```prisma
model coach_briefings {
  id            String   @id @db.Uuid
  owner         Int
  headline      String
  counsel       String
  evidence      String?
  trigger       String?  @db.VarChar(64)  // "analyst" if triggered by Param
  delivered     Boolean  @default(false)
  delivered_at  DateTime?
  date_created  DateTime @default(now()) @db.Timestamptz(6)

  @@index([owner, delivered])
}
```

---

### Configuration & Environment

**Environment Variables**:

```bash
ANALYSIS_VERSION=1                           # Set in code, auto-incremented on logic changes
ANALYST_GEMINI_API_KEY=<key>                # Google Gemini API key for LLM
WEB_API_URL=http://localhost:3000            # Base URL for API calls
SERVICE_API_TOKEN=<token>                    # Auth token for PATCH /api/transactions/:id
MILL_API_BASE_URL=http://localhost:3000      # Override WEB_API_URL if needed
DATABASE_URL=postgresql://...                # Prisma DB connection
DEV_USER_ID=2                                # Default user ID for single-user testing
```

**LLM Settings** (Gemini):

- Model: Google Gemini 2.0 Flash (via @ai-sdk/google)
- Temperature: Low (0.2-0.4) for consistent, factual output
- Max Tokens: 1000 (for 5-7 concise bullets)
- Streaming: Disabled (batch analysis, no real-time output)

---

### API Endpoints Called

#### 1. PATCH `/api/transactions/:id`

**Purpose**: Mark transactions as analyzed

**Headers**:

```
Content-Type: application/json
Authorization: Bearer <SERVICE_API_TOKEN> (if set)
```

**Body**:

```json
{
  "analyzed_at": "2025-11-22T14:30:00.000Z",
  "analyzed_version": 1,
  "analysis_notes": "Analyzed by param agent v1"
}
```

**Response**: Updated transaction object

#### 2. POST/PATCH `/api/habits`

**Purpose**: Sync habit insights to database

**Headers**:

```
Content-Type: application/json
Authorization: Bearer <SERVICE_API_TOKEN> (if set)
```

**Body** (HabitInsightPayload):

```json
{
  "habitLabel": "Overspending on Food",
  "evidence": "₹8K spent (40% of total)",
  "counsel": "Reduce by 25%, target ₹6K this month",
  "fullText": "- Overspending on Food: Evidence: ₹8K spent (40% of total); Counsel: Reduce by 25%...",
  "owner": 2
}
```

**Response**: Inserted/updated habit record

---

### Integration Points

#### Incoming Triggers

1. **CLI / Scheduled Job**:

   ```bash
   # From: scripts/run-analyst.ts or cron job
   node --loader ts-node/esm src/runtime/param/analyst-agent.ts
   # Calls: runAnalyst({ reanalyzeAll: false })
   ```

2. **Programmatic**:
   ```typescript
   // From: Coach-Analyst loop or other agents
   import { runAnalyst } from "@/runtime/param/analyst-agent";
   const result = await runAnalyst({ reanalyzeAll: false, ownerId: 2 });
   ```

#### Outgoing Calls

1. **To Coach**:

   ```typescript
   await runCoach({
     latestInsights: insights, // Fresh from this run
     previousInsights: oldInsights, // From loadExistingInsights()
     trigger: "analyst",
   });
   ```

2. **To Database** (via API):
   - Habits: `syncHabitToApi(payload)`
   - Transactions: `PATCH /api/transactions/:id`

---

### Error Handling & Resilience

**Non-Blocking Patterns**:

- **Transaction Mark Failures**: If `markTransactionsAsAnalyzed` fails for one TX, it continues with others (logged, not thrown)
- **Habit Persist Failures**: If `syncHabitToApi` fails for one insight, it continues with others
- **Coach Handoff Failures**: Caught and logged; main flow completes successfully
- **API Sync Failures**: Logged at error level; does not block analysis completion

**Fallback Behaviors**:

- **No Transactions**: Returns placeholder insight ("Insufficient History") to DB
- **Empty LLM Output**: Throws error, stops run with status="error"
- **Parse Failures**: Throws error, stops run with status="error"

---

### Performance Characteristics

**Time Complexity** (per analysis run):

- Load transactions: O(n)
- Build stats: O(n)
- LLM call: O(1) fixed (~2-5s)
- Parse & persist: O(m) where m = 5-7 insights
- Mark analyzed: O(n) sequential PATCH calls (~100-500ms per TX)

**Total**: ~3-10 seconds for typical user (50-200 transactions)

**Optimization Strategy**:

- Version tracking skips re-analysis if no new transactions
- Only patch changed transactions (set analyzed_at/analyzed_version)
- Batch API calls use sequential PATCH; consider bulk endpoint if scaling to 10K+ TX

---

### Testing & Validation

**Dry-Run Mode**:

```typescript
const result = await runAnalyst({ dryRun: true });
// Returns: { status: "success", totalTransactions: 50, analyzedTransactions: 5, insightsGenerated: 0 }
// Side effects: None (no DB writes)
```

**Force Re-Analysis**:

```typescript
const result = await runAnalyst({ reanalyzeAll: true });
// Forces all transactions to be re-analyzed regardless of version
// Useful for testing changes to analysis logic or LLM prompts
```

**Expected Output** (success case):

```json
{
  "status": "success",
  "totalTransactions": 45,
  "analyzedTransactions": 12,
  "insightsGenerated": 5,
  "message": "Analyzed 12 transactions, generated 5 insights"
}
```

---

## Core Capabilities

### 1. Pattern Recognition 🔍

**What it does**: Identifies spending, saving, and income patterns from transaction data

**Patterns Detected**:

- **Spending Habits**: Overspending categories, frequent merchants, impulse buying
- **Income Patterns**: Irregular income, consistent earnings, income sources
- **Saving Behavior**: Savings rate, proactive saving, insufficient reserves
- **Behavioral Flags**: Budget breaches, unusual purchases, category concentration

**Example Patterns**:

```
- "Overspending on Food & Dining: 43% of total spend"
- "Irregular Income Pattern: 3 deposits in 30 days, varying amounts"
- "Proactive Saving: Savings rate 0.49 (49%) last month"
- "Category Concentration Risk: 78% spent on single category"
```

### 2. Insight Generation 💡

**What it does**: Transforms raw metrics into actionable coaching insights

**Insight Structure** (Mandatory Format):

```
- Habit Label: [concise pattern name]; Evidence: [exact numbers]; Counsel: [direct action]
```

**Quality Rules**:

- Each bullet under 220 characters
- Contains habit label, evidence, and counsel
- Cites only supplied numbers from metrics
- No speculation or invented data
- 5-7 bullets per analysis
- Each bullet unique (no repeats)

**Example Insights**:

```
- Proactive Saving: Evidence: Savings rate 0.49 last 30 days; Counsel: Continue this strong practice, consider automating transfers
- Expense Focus: Evidence: ₹5,400 on Food (43% of ₹12,558); Counsel: Track meal-by-meal spending, set ₹4,000 monthly cap
- Income Stability: Evidence: 3 deposits totaling ₹25,000 in Oct; Counsel: Build 3-month emergency fund (₹75,000 target)
```

### 3. Metrics Analysis 📈

**What it does**: Processes comprehensive financial analytics snapshots

**Analyzed Metrics**:

- **Transaction Volume**: Total count, frequency patterns
- **Amount Analysis**: Total spent, earned, average transaction size
- **Category Breakdown**: Top categories by amount and percentage
- **Merchant Analysis**: Frequent vendors, spending concentration
- **Time Patterns**: Daily/weekly/monthly trends
- **Behavioral Flags**: Anomalies, threshold breaches, risk indicators

**Input Format** (JSON):

```json
{
  "totalTransactions": 45,
  "totalSpent": 12558.5,
  "totalEarned": 25000.0,
  "netBalance": 12441.5,
  "savingsRate": 0.49,
  "topCategories": [
    { "category": "Food & Dining", "amount": 5400, "percentage": 43 },
    { "category": "Transport", "amount": 2100, "percentage": 17 }
  ],
  "frequentMerchants": [{ "merchant": "Swiggy", "count": 15, "amount": 3200 }],
  "flags": {
    "overspending": false,
    "impulseBuying": true,
    "irregularIncome": true,
    "lowSavings": false
  }
}
```

### 4. Habit Snapshot Creation 📸

**What it does**: Generates reusable financial behavior snapshots for coaching

**Snapshot Contents**:

- **Insights List**: 5-7 actionable habit insights
- **Summary Data**: Key metrics overview
- **Top Categories**: Spending distribution
- **Frequent Merchants**: Transaction patterns
- **Behavioral Flags**: Risk indicators
- **Generated Timestamp**: When analysis performed

**Storage**: Saved to `habit_snapshots` table for historical tracking

---

## Tools & Integration

### Available Tools

#### 1. `metrics_snapshot`

**Purpose**: Provides structured analytics data for evidence  
**Parameters**: None (system provides)

**Returns**: Complete financial metrics JSON (see above format)

#### 2. `habit_recommendation`

**Purpose**: Translates detected pattern into actionable coaching tip  
**Parameters**:

- `pattern` (string) - Short title of detected habit
- `evidence` (string) - Key metric justifying observation
- `action` (string) - Actionable recommendation

**Returns**: Formatted insight bullet

**Example Usage**:

```typescript
habit_recommendation({
  pattern: "Overspending on Food",
  evidence: "₹5,400 spent (43% of total ₹12,558)",
  action: "Set ₹4,000 monthly cap, track meal-by-meal",
});

Output: "- Overspending on Food: Evidence: ₹5,400 spent (43% of total ₹12,558); Counsel: Set ₹4,000 monthly cap, track meal-by-meal";
```

---

## Analysis Protocol

### Mandatory Flow (4 Steps)

#### Step 1: Ingest & Internalize

- Absorb every metric in provided JSON
- Treat data as only source of truth
- No external assumptions

#### Step 2: Identify Core Narrative

- Surface most impactful patterns
- Prioritize: spending > income > saving
- Ignore trivial signals (small amounts, rare occurrences)

#### Step 3: Translate to Actionable Insights

- Create 5-7 bullets
- Each bullet: habit label + evidence + counsel
- Cite exact numbers from payload
- Keep under 220 characters per bullet

#### Step 4: Quality & Grounding

- Verify all numbers from source data
- Avoid speculation beyond metrics
- Ensure recommendations practical and supportive
- No judgment, just facts and guidance

---

## Interaction Patterns

### With Users

**Interaction**: **INDIRECT** - Param never talks to users directly

Users see Param's insights through Mill (when querying spending) or Chatur (when receiving coaching).

**User Experience**:

```
User asks Mill: "How's my spending?"
Mill shows: "Here are your recent patterns (analyzed by Param):
- Proactive Saving: 49% savings rate last month
- Food spending high: ₹5,400 (43% of total)
..."
```

### With Other Agents

#### → Mill (Chatbot)

**Relationship**: Data provider  
**Communication**: Param's insights included in Mill's spending query responses

**Data Flow**:

1. User asks Mill about spending
2. Mill calls `query_spending_summary`
3. System includes Param's latest habit insights
4. Mill presents insights to user (attributed to Param)

**Example**:

```
User: "Show my spending"
Mill: "Here's your financial snapshot! 📊
[transaction data]

Param's Analysis:
- Proactive Saving: 49% savings rate
- Food spending: ₹5,400 (43%)
- Income stability: 3 deposits, ₹25K total
..."
```

#### → Chatur (Coach)

**Relationship**: Primary consumer of insights  
**Communication**: Chatur uses Param's insights as foundation for coaching

**Data Flow**:

1. Param analyzes transaction data → Generates insights
2. Insights stored in database
3. Chatur retrieves insights when coaching
4. Chatur builds on Param's evidence for personalized advice

**Example**:

```
Param: "Overspending on Food: ₹5,400 (43%)"
Chatur: "Based on your spending patterns, I recommend reducing food expenses by 20% (₹1,080). This frees up funds for your house savings goal. Start with one less food delivery per week."
```

#### → Dev (SMS Parser)

**Relationship**: Data consumer  
**Communication**: No direct interaction

**Data Flow**:

- Dev extracts transactions from SMS
- Transactions stored in database
- Param analyzes all transactions (manual + SMS)
- Param generates insights from complete data

#### → Sera (Shopping Assistant)

**Relationship**: No interaction  
**Communication**: None

**Note**: Param analyzes spending patterns; Sera helps find products. No overlap.

---

## Insight Categories

### Financial Habits Tracked

1. **Spending Patterns**

   - Overspending (category or overall)
   - Impulse buying
   - Luxury/discretionary vs necessities
   - Merchant concentration

2. **Income Patterns**

   - Regular income (salary)
   - Irregular income (gig work)
   - Income sources diversity
   - Earning consistency

3. **Saving Behavior**

   - Savings rate (percentage)
   - Proactive saving (intentional transfers)
   - Emergency fund adequacy
   - Insufficient reserves

4. **Budget Alignment**

   - Category budget adherence
   - Spending threshold breaches
   - Monthly vs weekly trends
   - Unusual purchases

5. **Risk Indicators**
   - Low savings (<20% rate)
   - High debt/EMI burden
   - Irregular income + high spending
   - Single category dominance

---

## Output Examples

### Example 1: Balanced Finances

**Input Metrics**:

```json
{
  "totalSpent": 15000,
  "totalEarned": 30000,
  "savingsRate": 0.5,
  "topCategories": [
    { "category": "Food", "amount": 4500, "percentage": 30 },
    { "category": "Transport", "amount": 3000, "percentage": 20 },
    { "category": "Savings", "amount": 7500, "percentage": 50 }
  ],
  "flags": { "overspending": false, "lowSavings": false }
}
```

**Param's Output**:

```
- Proactive Saving: Evidence: 50% savings rate (₹15K saved from ₹30K income); Counsel: Excellent discipline, maintain this habit
- Balanced Spending: Evidence: Food 30% (₹4.5K), Transport 20% (₹3K); Counsel: Well-distributed, no category dominating
- Income Stability: Evidence: ₹30K monthly earning; Counsel: Build 3-month emergency fund (₹45K target)
- Transport Efficiency: Evidence: ₹3K on transport (20% of spend); Counsel: Track commute vs Uber; optimize routes
- Food Budget: Evidence: ₹4.5K on food (30%); Counsel: Healthy spending; meal prep could save extra ₹500/month
```

### Example 2: Overspending Alert

**Input Metrics**:

```json
{
  "totalSpent": 22000,
  "totalEarned": 20000,
  "savingsRate": -0.1,
  "topCategories": [
    { "category": "Shopping", "amount": 10000, "percentage": 45 },
    { "category": "Food", "amount": 8000, "percentage": 36 }
  ],
  "flags": { "overspending": true, "impulseBuying": true, "lowSavings": true }
}
```

**Param's Output**:

```
- Overspending Alert: Evidence: ₹22K spent vs ₹20K earned (110% of income); Counsel: Immediate spending freeze on non-essentials
- Shopping Dominance: Evidence: ₹10K on shopping (45% of spend); Counsel: Implement 24-hour rule for purchases >₹500
- Food Expense High: Evidence: ₹8K on food (36%); Counsel: Reduce deliveries by 50%, cook 3 more meals/week, save ₹2K
- Negative Savings: Evidence: -10% savings rate (₹2K deficit); Counsel: Cut shopping + food by ₹3K total to break even
- Impulse Buying Detected: Evidence: Multiple small purchases, no pattern; Counsel: Use wishlist approach, wait 48 hours before buying
```

### Example 3: Gig Worker (Irregular Income)

**Input Metrics**:

```json
{
  "totalSpent": 12000,
  "totalEarned": 18000,
  "savingsRate": 0.33,
  "income": [
    { "date": "2025-10-05", "amount": 8000 },
    { "date": "2025-10-15", "amount": 5000 },
    { "date": "2025-10-28", "amount": 5000 }
  ],
  "flags": { "irregularIncome": true, "lowSavings": false }
}
```

**Param's Output**:

```
- Irregular Income Pattern: Evidence: 3 deposits (₹8K, ₹5K, ₹5K) over 30 days; Counsel: Build 4-month emergency buffer (₹48K)
- Healthy Savings: Evidence: 33% savings rate (₹6K saved from ₹18K); Counsel: Great discipline with variable income, keep it up
- Income Volatility: Evidence: Earnings vary ₹3K between weeks; Counsel: Seek 1-2 regular clients for base income stability
- Spending Control: Evidence: ₹12K spent vs ₹18K earned; Counsel: Well-managed given income uncertainty, maintain this ratio
- Gig Sustainability: Evidence: Total ₹18K monthly from gigs; Counsel: Diversify income sources to reduce single-client risk
```

---

## Technical Architecture

### Database Interactions

**Reads**:

- Transactions via `loadTransactions()` → Prisma `tranasctions.findMany()`
- Previous insights via `loadExistingInsights()` → Prisma `habit_insights.findMany()` (latest 5)

**Writes**:

- Habit insights via `syncHabitToApi()` → POST/PATCH to `/api/habits` (creates/updates `habit_insights`)
- Transaction metadata via PATCH `/api/transactions/:id` (sets `analyzed_at`, `analyzed_version`, `analysis_notes`)

**Transaction Tracking**:

- All transactions loaded with metadata fields: `analyzed_at` (nullable datetime), `analyzed_version` (nullable int)
- Version filtering: `WHERE analyzed_version != 1` to find unanalyzed work
- Efficient indexing: `@@index([owner, analyzed_version])` for fast lookups

**Endpoints** (via web/src/lib/mill/in-process-adapter.ts):

- `GET /api/habits?owner={id}` - Fetch recent insights
- `POST /api/habits` - Create/update habit insight
- `PATCH /api/transactions/:id` - Mark transaction as analyzed

### External Services

- **Google Gemini**: Powers analytical AI (ANALYST_GEMINI_API_KEY)
- **PostgreSQL**: Stores insights, snapshots, and transaction metadata (via Prisma)
- **LLM Client Wrapper** (`src/runtime/shared/llm-client.ts`): Handles retries, circuit breaker, error fallbacks

### Runtime Structure

- **Entry Point**: `src/agents/analyst.ts` (agent definition + system prompt)
- **Runtime Logic**: `src/runtime/param/analyst-agent.ts` (main runAnalyst orchestrator)
- **Utilities**:
  - `transactions-loader.ts` - Fetch & normalize transaction data
  - `habit-tracker.ts` - Incremental habit snapshots (for future use with Chatur streaming)
  - `index.ts` - Public exports

### Coach Integration

After analysis completes, Param automatically hands off to Coach:

```typescript
// In runAnalyst() after insight generation
await runCoach({
  latestInsights: insights, // Fresh insights from this run
  previousInsights: oldInsights, // Historical context for comparison
  trigger: "analyst", // Metadata for coach session
});
```

**Coach Responsibilities**:

1. Compare latest vs previous insights (trend detection)
2. Generate coaching briefings
3. Store briefings in `coach_briefings` table
4. Detect escalation signals (e.g., overspending alerts)

---

## Importance in System

### Primary Role

Param is the **analytical engine** that transforms raw transaction data into meaningful financial intelligence.

### Critical Functions

1. **Pattern Detection**: Identifies habits users don't see themselves
2. **Evidence Provider**: Gives coaches concrete data to reference
3. **Objective Analysis**: Removes human bias from financial assessment
4. **Trend Tracking**: Monitors changes over time (snapshots)

### System Dependencies

- **Depends on**: Transaction data (from Mill, Dev), Previous snapshots
- **Depended on by**: Mill (shows insights), Chatur (builds coaching on insights)

### Data Flow Position

```
Transactions (Mill + Dev) → Param Analysis → Insights → Mill (display) + Chatur (coaching)
```

### Unique Value

**Without Param**: Users and coaches see raw numbers only  
**With Param**: Everyone sees patterns, trends, and actionable insights

---

## Analysis Triggers

### When Param Runs (Current v1.1)

#### 1. **Scheduled Job (Nightly)**

**Trigger**: Cron job or manual invocation  
**Command**:

```bash
node --loader ts-node/esm src/runtime/param/analyst-agent.ts
```

**Behavior**:

- Calls `runAnalyst({ reanalyzeAll: false })` (default)
- Analyzes only transactions where `analyzed_version != 1` (new/updated only)
- Skips if all transactions already analyzed (fast return)
- Runs in ~3-10 seconds for typical user

**Output**:

```json
{
  "status": "success",
  "totalTransactions": 50,
  "analyzedTransactions": 3,
  "insightsGenerated": 5,
  "message": "Analyzed 3 new transactions, generated 5 insights"
}
```

#### 2. **User Query via Mill**

**Trigger**: User asks "Show my spending"  
**Flow**:

1. User → Mill chatbot
2. Mill calls `/api/agent` (post message)
3. Router detects "spending" keyword
4. Router calls `query_spending_summary` tool
5. System fetches latest insights from `habit_insights` table (populated by Param)
6. Mill displays insights to user (attributed to Param)

**Output**: Insight text displayed in chat, no re-analysis triggered (uses cached insights)

#### 3. **Manual Re-Analysis**

**Trigger**: Developer or admin  
**Command**:

```bash
node --loader ts-node/esm -e "import { runAnalyst } from './src/runtime/param/analyst-agent.js'; runAnalyst({ reanalyzeAll: true }).then(r => console.log(r));"
```

**Behavior**:

- Analyzes ALL transactions regardless of version
- Useful for testing changes to analysis logic or LLM prompts
- Overwrites previous insights

**Output**: Same format as scheduled job

#### 4. **Coach Handoff (Automatic)**

**Trigger**: After successful Param analysis  
**Flow**:

1. Param generates insights
2. Param calls `runCoach({ latestInsights, previousInsights, trigger: "analyst" })`
3. Coach session created with context
4. Coach generates briefings (insights + recommendations)
5. Briefings stored in `coach_briefings` table

**Output**: Coach briefings generated and ready for delivery

### Planned Triggers (Future)

- **Transaction Threshold**: Analyze when new transaction > 1.5x average spend
- **Pattern Detection**: Auto-analyze when category spending exceeds budget
- **Weekly Summary**: Generate insights every Sunday 6 AM
- **Significant Event**: Detect anomalies (fraud flags, income changes)

---

## Quality Assurance

### Insight Validation Checklist

Before outputting insights, Param ensures:

- ✅ Each bullet has habit label, evidence, and counsel
- ✅ All numbers cited exist in source metrics
- ✅ Character count <220 per bullet
- ✅ 5-7 bullets total (no more, no less)
- ✅ Each bullet addresses unique observation
- ✅ Recommendations are practical and actionable
- ✅ Tone is supportive, not judgmental
- ✅ No speculation beyond provided data

### Common Mistakes to Avoid

- ❌ Inventing numbers not in metrics
- ❌ Generic advice without specific evidence
- ❌ Judging user's choices (neutral tone only)
- ❌ Exceeding character limits
- ❌ Duplicate or repetitive insights
- ❌ Vague recommendations ("spend less" vs "reduce food by ₹1K")

---

## Configuration

### Environment Variables

```bash
ANALYST_GEMINI_API_KEY=<gemini-api-key>
WEB_API_URL=http://localhost:3000
SERVICE_API_TOKEN=<service-token>
DEV_USER_ID=2
```

### Agent Settings

- **Model**: Gemini (via Vercel AI SDK)
- **Temperature**: Low (for consistent, factual output)
- **Max Tokens**: Medium (for 5-7 concise bullets)
- **Streaming**: Disabled (batch analysis)

---

## Success Metrics

### Effectiveness Indicators

- ✅ Insights are cited by Chatur in coaching sessions
- ✅ Users act on recommendations
- ✅ Patterns detected lead to behavior change
- ✅ Insights are clear and understandable

### Quality Indicators

- ✅ All insights grounded in real data
- ✅ Recommendations specific and actionable
- ✅ Character limits respected
- ✅ Consistent format across all outputs

---

## Best Practices

### For Developers

1. **Enrich metrics**: Provide comprehensive data to Param
2. **Validate output**: Ensure insights follow format rules
3. **Monitor accuracy**: Check that numbers match source data
4. **Test edge cases**: Zero transactions, negative balance, etc.

### For System Administrators

1. **Schedule regular analysis**: Weekly snapshots for trend tracking
2. **Archive old snapshots**: Maintain performance
3. **Monitor Gemini usage**: Ensure API quota sufficient
4. **Review insight quality**: Periodic human validation

---

## Future Enhancements

### Planned Features

- Comparative analysis (this month vs last month)
- Goal progress tracking (% toward target)
- Predictive insights (projected spending)
- Anomaly detection (unusual transactions)
- Peer benchmarking (anonymized comparisons)

### Potential Improvements

- Multi-period trend analysis
- Category budget recommendations
- Machine learning for pattern detection
- Custom insight templates per user type
- Natural language insight generation

---

## Comparison with Manual Analysis

| Aspect                | Param (Automated)                 | Manual Review             |
| --------------------- | --------------------------------- | ------------------------- |
| **Speed**             | Instant                           | Hours                     |
| **Consistency**       | Always follows protocol           | Varies                    |
| **Bias**              | Data-driven only                  | Human judgment involved   |
| **Scale**             | Unlimited transactions            | Limited by time           |
| **Pattern Detection** | AI-powered, finds hidden patterns | May miss subtle trends    |
| **Cost**              | Pennies (API calls)               | Expensive (human analyst) |

**Verdict**: Param provides analyst-level insights at chatbot speed and cost! 🚀

---

## Param Trigger Remapping (Updated Nov 2025)

### New Trigger Model

**Old**: Param runs automatically after every transaction  
**New**: Param triggered **only by Chatur**, **once per day maximum**

```typescript
// Old (auto-run): Would analyze on every transaction
runAnalyst({ reanalyzeAll: false });

// New (Chatur-triggered, once daily):
const lastRun = await getLastAnalysisRun(userId); // Check last 24h
if (!lastRun || isOlderThanOneDay(lastRun)) {
  const result = await runAnalyst({
    ownerId: userId,
    reanalyzeAll: false, // Only new transactions
  });
  await recordAnalysisRun(userId, result);
}
```

**Benefits**:

- ✅ 90% fewer LLM calls (1 per day vs many per day)
- ✅ Less API/database load
- ✅ More meaningful analysis (weekly/daily patterns vs immediate)
- ✅ Better cache hit rate

### Smart Incremental Analysis

**Old**: Re-analyze all transactions every time  
**New**: Only analyze new transactions, reuse old insights

```typescript
// Load only NEW transactions (not seen in previous analysis_version)
const newTransactions = await prisma.tranasctions.findMany({
  where: {
    owner: userId,
    analyzed_version: { not: ANALYSIS_VERSION },
  },
});

// Reuse old analyses for existing patterns
const existingInsights = await loadExistingInsights(userId);
// Merge new findings with old insights instead of replacing
const mergedInsights = mergeWithExisting(newInsights, existingInsights);
```

**Benefits**:

- ✅ Only new transactions processed (50-80% faster)
- ✅ Existing insights retained and enhanced, not discarded
- ✅ Continuous context (old + new = complete picture)

### Update Instead of Create

**Old**: Create new insight for every category each run  
**New**: Update existing insight if same category detected

```typescript
// Find if insight already exists for this category
const existing = await prisma.habit_insights.findFirst({
  where: {
    owner: userId,
    habit_label: "Overspending on Food", // Same pattern
  },
  orderBy: { recorded_at: "desc" },
});

if (existing) {
  // Update with new evidence, maintain history
  await prisma.habit_insights.update({
    where: { id: existing.id },
    data: {
      evidence: newEvidence, // New data
      counsel: updatedCounsel, // Refreshed advice
      updated_at: now(),
      version: existing.version + 1,
    },
  });
} else {
  // Create new only if truly new pattern
  await prisma.habit_insights.create({ data: newInsight });
}
```

**Benefits**:

- ✅ No duplicate insights for same patterns
- ✅ Versioned history per insight (can compare trends)
- ✅ Cleaner DB (fewer rows)

---

## Coach Briefings as Conversation Storage (New Nov 2025)

### Purpose Redefined

**Old**: One-way briefings generated by Param  
**New**: Q&A conversation log (Chatur responses + context)

```typescript
// When user asks Chatur a question:
const userQuestion = "Should I buy a laptop?";

// 1. Check if similar question answered recently
const cachedAnswer = await findSimilarQuestion(userQuestion, userId);
if (cachedAnswer && isRecent(cachedAnswer.askedAt)) {
  // Reuse cached answer
  return cachedAnswer.answer;
}

// 2. Generate new answer with relevant context
const insights = await prisma.habit_insights.findMany({
  where: { owner: userId },
  orderBy: { recorded_at: "desc" },
  take: 5,
});

const answer = await generateCoachResponse(userQuestion, insights);

// 3. Store Q&A for future reference
await prisma.coach_briefings.create({
  data: {
    owner: userId,
    question: userQuestion,
    answer: answer,
    context_insights_hash: hashInsights(insights),
    question_hash: hashQuestion(userQuestion),
    created_at: now(),
    reused_count: 0,
    triggered_by: "chatur",
  },
});

return answer;
```

### Smart Deduplication in Briefings

**Detection**: Hash-based question similarity + embedding distance

```typescript
async function findSimilarQuestion(
  userQuestion: string,
  userId: number,
  threshold: number = 0.85
) {
  const questionHash = hashQuestion(userQuestion);

  // Exact match first (fast)
  const exactMatch = await prisma.coach_briefings.findFirst({
    where: {
      owner: userId,
      question_hash: questionHash,
      created_at: { gte: oneDayAgo() },
    },
  });

  if (exactMatch) {
    // Increment reuse counter
    await prisma.coach_briefings.update({
      where: { id: exactMatch.id },
      data: { reused_count: { increment: 1 } },
    });
    return exactMatch;
  }

  // Semantic similarity (if new question)
  const embedding = await getEmbedding(userQuestion);
  const similar = await findSemanticallySimilar(embedding, userId, threshold);

  if (similar && similar.context_insights_hash === currentInsightHash) {
    // Context hasn't changed, reuse answer
    return similar;
  }

  return null;
}
```

### Context Invalidation

```typescript
// New insights invalidate old Q&A answers
// (Same question but different financial situation = new answer)

const oldBriefing = await findCachedAnswer(userQuestion);
if (oldBriefing) {
  const oldContext = oldBriefing.context_insights_hash;
  const newContext = await hashCurrentInsights(userId);

  if (oldContext !== newContext) {
    // Context changed → invalidate old answer
    await prisma.coach_briefings.update({
      where: { id: oldBriefing.id },
      data: { valid_until: now() }, // Mark expired
    });

    // Generate new answer
    return generateNewCoachResponse(userQuestion);
  }

  // Same context → reuse answer
  return oldBriefing.answer;
}
```

### Storage Schema Update

**coach_briefings**: Now stores full conversations

```prisma
model coach_briefings {
  id                      String    @id @db.Uuid
  owner                   Int
  question                String    @db.Text              // User's question
  answer                  String    @db.Text              // Coach's response
  question_hash           String    @db.VarChar(64)       // For dedup
  context_insights_hash   String    @db.VarChar(64)       // Invalidation
  triggered_by            String    @default("chatur")    // Only "chatur"
  reused_count            Int       @default(0)           // How many times reused
  valid_until             DateTime? @db.Timestamptz(6)    // Expiry marker
  created_at              DateTime  @default(now()) @db.Timestamptz(6)
  updated_at              DateTime? @db.Timestamptz(6)

  @@index([owner, created_at])
  @@index([question_hash, owner])
  @@index([context_insights_hash])
}
```

---

## Related Agent Changes (Nov 2025)

### Mill (Chatbot) Updates

- **Router-native entrypoint** – Mill now runs inside `ConversationRouter` via `web/src/lib/mill/in-process-adapter.ts`
- **State snapshots with Redis fallback** – Sessions persist via `getConversationStore()` (Redis or in-memory)
- **Structured actions & attachments** – Emits typed `log_transaction`, `query_data`, `escalate_to_coach` actions with payloads

**Key Integration**: Mill calls `query_spending_summary` which fetches Param's latest insights from `habit_insights` table and displays them to users.

### Chatur (Coach) Updates

- **Router-seeded sessions** – `ConversationalCoach` slots into `ConversationRouter`, cold-starts with Param's insights
- **Structured guidance loop** – Responses generated via JSON schema capturing `nextQuestion`, goal metadata, and `shouldEscalateToMill` flags
- **Resilient LLM calls** – Uses circuit breaker + exponential backoff (overload-specific retries) and rule-based fallbacks
- **Now triggers Param** – Checks if daily analysis needed before responding to user questions
- **Smart caching** – Checks coach_briefings for similar questions before generating new response

**Key Integration**: Chatur triggers Param (if 24h+ since last run), gets insights, generates/retrieves cached answer, stores in coach_briefings.

### Sera (Shopping Assistant) Updates

- **Router-integrated sessions** – Sera runs in shared router, shares conversation context across agents
- **No direct Param interaction** – Focused on product search and recommendations only

**Key Integration**: Sera coordinates with Mill/Chatur; receives user handoffs when shopping queries detected.

### Conversation Router (Shared)

- **Keyword-based routing** – Routes between mill/chatur/sera based on message content and context
- **Session hydration** – Rehydrates correct agent session on every `/api/agent` call
- **State persistence** – Uses `getConversationStore()` for cross-request session continuity

**Database**: Uses `habit_insights` and transaction data to seed agent context on cold-start.

---

**Last Updated**: November 22, 2025  
**Version**: 1.1.0  
**Status**: Production Ready ✅
