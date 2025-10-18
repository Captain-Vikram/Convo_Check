# Runtime Module Structure

Organized multi-agent system with clear separation of concerns. Each agent has its own folder with dedicated tools and utilities.

## 📁 Folder Organization

```
src/runtime/
├── mill/               # Mill Agent (Chatbot)
│   ├── chatbot-session.ts
│   ├── conversational-mill.ts
│   ├── intent-parser.ts
│   └── index.ts
│
├── dev/                # Dev Agent (Data Gateway)
│   ├── dev-agent.ts
│   ├── dev-sms-agent.ts
│   ├── dev-llm-parser.ts
│   ├── sms-log.ts
│   ├── transaction-normalizer.ts
│   └── index.ts
│
├── param/              # Param Agent (Analyst)
│   ├── analyst-agent.ts
│   ├── transactions-loader.ts
│   └── index.ts
│
├── chatur/             # Chatur Agent (Coach)
│   ├── coach-agent.ts
│   ├── conversational-coach.ts
│   └── index.ts
│
├── shared/             # Shared Utilities
│   ├── agent-message-bus.ts
│   ├── agent-orchestrator.ts
│   ├── conversation-router.ts
│   ├── error-handling.ts
│   ├── atomic-csv.ts
│   ├── categorize.ts
│   ├── accountant.ts
│   └── index.ts
│
└── index.ts            # Main runtime exports
```

## 🎯 Agent Responsibilities

### Mill Agent (`mill/`)

**Role:** Chatbot & Transaction Logger

- User interaction interface
- Conversational transaction logging
- Intent detection and parsing
- Multi-turn dialogue management

**Key Files:**

- `chatbot-session.ts` - Session management
- `conversational-mill.ts` - Conversational interface
- `intent-parser.ts` - User intent detection

### Dev Agent (`dev/`)

**Role:** Data Gateway & SMS Processor

- SMS export ingestion
- Transaction normalization
- Optimized CSV storage (13 essential fields)
- Duplicate detection & resolution

**Key Files:**

- `dev-agent.ts` - Core agent logic with optimized storage
- `dev-sms-agent.ts` - SMS processing pipeline
- `dev-llm-parser.ts` - LLM-based SMS extraction
- `transaction-normalizer.ts` - Data normalization
- `sms-log.ts` - SMS logging utilities

**Storage Format:**

```csv
owner_phone,transaction_id,datetime,date,time,amount,currency,type,
target_party,description,category,is_financial,medium
```

### Param Agent (`param/`)

**Role:** Financial Analyst

- Spending pattern analysis
- Trend detection
- Financial insights generation
- Data aggregation & queries

**Key Files:**

- `analyst-agent.ts` - Analysis engine
- `transactions-loader.ts` - Data loading utilities

### Chatur Agent (`chatur/`)

**Role:** Financial Coach

- Personalized financial advice
- Habit formation guidance
- Spending behavior coaching
- Goal setting & tracking

**Key Files:**

- `coach-agent.ts` - Coaching logic
- `conversational-coach.ts` - Conversational coaching interface

### Shared Utilities (`shared/`)

**Role:** Cross-Agent Infrastructure

- Inter-agent communication
- Error handling & resilience
- Data operations
- Common utilities

**Key Files:**

- `agent-message-bus.ts` - Event-based messaging
- `agent-orchestrator.ts` - LLM-based routing
- `conversation-router.ts` - Agent coordination
- `error-handling.ts` - Circuit breakers, retries
- `atomic-csv.ts` - Safe CSV operations
- `categorize.ts` - Transaction categorization
- `accountant.ts` - Financial calculations

## 📦 Import Patterns

### Import from specific agent folders:

```typescript
// Mill Agent
import { ConversationalMill, IntentParser } from "./runtime/mill";

// Dev Agent
import { createDevAgentEnvironment, ingestSmsExport } from "./runtime/dev";

// Param Agent
import { AnalystAgent, loadTransactions } from "./runtime/param";

// Chatur Agent
import { ConversationalCoach, CoachAgent } from "./runtime/chatur";

// Shared utilities
import {
  ConversationRouter,
  CircuitBreaker,
  atomicCsvWrite,
} from "./runtime/shared";
```

### Import from main runtime (namespaced):

```typescript
import { Mill, Dev, Param, Chatur, Shared } from "./runtime";

// Usage
const mill = new Mill.ConversationalMill(config);
const devEnv = await Dev.createDevAgentEnvironment();
const router = new Shared.ConversationRouter();
```

## 🔄 Data Flow

```
SMS Export → Dev Agent → Optimized CSV Storage
                ↓
        Mill Agent ← User Input
                ↓
        Param Agent → Analysis
                ↓
        Chatur Agent → Coaching Insights
```

## 🛠️ Key Features

### Optimized Storage (Dev Agent)

- **13 essential fields** instead of 19+ verbose fields
- **ISO datetime format** for easy sorting
- **Omits redundants**: full message text, score, sender
- **Atomic operations**: prevents corruption

### Conversational Agents (Mill & Chatur)

- **Multi-turn dialogues** with context retention
- **Intent detection** via LLM
- **Agent escalation** (Mill→Chatur for advice, Chatur→Mill for transactions)

### Resilience (Shared)

- **Circuit breakers** prevent cascading failures
- **Exponential backoff** retries
- **Atomic CSV writes** with temp file + rename pattern

## 📊 Storage Optimization

**Before:** 19 columns with redundant data

```
transaction_id, recorded_at, event_date, event_time, direction, amount,
currency, category, flavor, description, raw_text, tags, structured_summary,
heuristics, raw_category_suggestion, parsed_temporal_phrase, meta_source,
meta_medium, meta_target_party
```

**After:** 13 essential columns

```
owner_phone, transaction_id, datetime, date, time, amount, currency, type,
target_party, description, category, is_financial, medium
```

**Benefits:**

- 30% smaller file size
- Faster queries
- Cleaner data structure
- Easier agent consumption

## 🚀 Usage Examples

### 1. Ingest SMS Export

```typescript
import { ingestSmsExport } from "./runtime/dev";

const summary = await ingestSmsExport("sms_export.json");
console.log(`Processed ${summary.processed} transactions`);
```

### 2. Start Conversational Mill

```typescript
import { ConversationalMill } from "./runtime/mill";

const mill = new ConversationalMill(config);
const response = await mill.startConversation(
  "I spent 250 rupees on groceries yesterday"
);
```

### 3. Get Financial Analysis

```typescript
import { AnalystAgent } from "./runtime/param";

const insights = await AnalystAgent.analyzeSpending({
  startDate: "2025-09-01",
  endDate: "2025-09-30",
});
```

### 4. Route Conversations

```typescript
import { ConversationRouter } from "./runtime/shared";

const router = new ConversationRouter();
const response = await router.routeInitialMessage(
  "I need advice on saving money"
);
```

## 🔧 Maintenance

### Adding New Agent Tools

1. Create file in appropriate agent folder (`mill/`, `dev/`, `param/`, `chatur/`)
2. Export from agent's `index.ts`
3. Update this README

### Adding Shared Utilities

1. Create file in `shared/` folder
2. Export from `shared/index.ts`
3. Document usage patterns

## 📝 Notes

- All imports use `.js` extensions for ESM compatibility
- Each folder has its own `index.ts` for clean exports
- Shared utilities avoid duplication across agents
- Optimized storage format prioritizes agent query performance
