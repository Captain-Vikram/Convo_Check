# Runtime Folder Structure - Visual Guide

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     src/runtime/                                │
│                 Multi-Agent System Runtime                      │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐     ┌───────────────┐    ┌───────────────┐
│  Agent Modules│     │ Shared Utils  │    │ Documentation │
└───────────────┘     └───────────────┘    └───────────────┘
```

## 📂 Detailed Structure

```
src/runtime/
│
├── 👤 mill/                    [Mill Agent - Chatbot]
│   ├── chatbot-session.ts      Session management
│   ├── conversational-mill.ts  Multi-turn dialogues
│   ├── intent-parser.ts        Intent detection
│   └── index.ts                Agent exports
│
├── 🔄 dev/                     [Dev Agent - Data Gateway]
│   ├── dev-agent.ts            Core agent (optimized storage)
│   ├── dev-sms-agent.ts        SMS ingestion pipeline
│   ├── dev-llm-parser.ts       LLM extraction
│   ├── sms-log.ts              SMS logging
│   ├── transaction-normalizer.ts  Data reshaping
│   └── index.ts                Agent exports
│
├── 📊 param/                   [Param Agent - Analyst]
│   ├── analyst-agent.ts        Analysis engine
│   ├── transactions-loader.ts  Data queries
│   └── index.ts                Agent exports
│
├── 💡 chatur/                  [Chatur Agent - Coach]
│   ├── coach-agent.ts          Coaching logic
│   ├── conversational-coach.ts Multi-turn coaching
│   └── index.ts                Agent exports
│
├── 🔧 shared/                  [Cross-Agent Infrastructure]
│   ├── agent-message-bus.ts    Event messaging
│   ├── agent-orchestrator.ts   Smart routing
│   ├── conversation-router.ts  Agent coordination
│   ├── error-handling.ts       Resilience (circuit breakers)
│   ├── atomic-csv.ts           Safe CSV ops
│   ├── categorize.ts           Transaction categorization
│   ├── accountant.ts           Financial calculations
│   └── index.ts                Shared exports
│
├── index.ts                    Main runtime exports
└── README.md                   📖 Documentation
```

## 🔀 Agent Interaction Flow

```
┌──────────┐
│   User   │
└────┬─────┘
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│              shared/conversation-router.ts               │
│            (Intelligent Agent Selection)                 │
└──────────────┬──────────────────┬───────────────────────┘
               │                  │
     ┌─────────┴─────┐      ┌─────┴──────┐
     ▼               ▼      ▼            ▼
┌─────────┐    ┌──────────────┐    ┌──────────┐
│  mill/  │◄──►│   shared/    │◄──►│ chatur/  │
│ Chatbot │    │ Message Bus  │    │  Coach   │
└────┬────┘    └──────┬───────┘    └─────┬────┘
     │                │                   │
     │           ┌────▼────┐              │
     │           │  dev/   │              │
     └──────────►│ Gateway │◄─────────────┘
                 └────┬────┘
                      │
                 ┌────▼────┐
                 │  CSV    │
                 │ Storage │
                 └────┬────┘
                      │
                 ┌────▼────┐
                 │ param/  │
                 │ Analyst │
                 └─────────┘
```

## 🎯 Separation of Concerns

### 1. Agent-Specific Tools (mill/, dev/, param/, chatur/)

Each agent folder contains **only** the tools and logic specific to that agent:

| Agent  | Folder    | Purpose                  | Key Files                                |
| ------ | --------- | ------------------------ | ---------------------------------------- |
| Mill   | `mill/`   | User interaction         | conversational-mill.ts, intent-parser.ts |
| Dev    | `dev/`    | Data ingestion & storage | dev-agent.ts, dev-sms-agent.ts           |
| Param  | `param/`  | Financial analysis       | analyst-agent.ts, transactions-loader.ts |
| Chatur | `chatur/` | Coaching & advice        | conversational-coach.ts, coach-agent.ts  |

### 2. Shared Infrastructure (shared/)

Common utilities used by **multiple agents**:

```
agent-message-bus.ts      → All agents (inter-agent communication)
agent-orchestrator.ts     → Router + agents (smart routing)
conversation-router.ts    → Mill + Chatur (conversation coordination)
error-handling.ts         → All agents (resilience)
atomic-csv.ts             → Dev + Param (safe storage)
categorize.ts             → Dev + Mill (transaction categorization)
accountant.ts             → Param + Chatur (financial calculations)
```

## 📊 File Count by Category

```
Chatbot (mill/)        : 4 files
Data Gateway (dev/)    : 6 files
Analyst (param/)       : 3 files
Coach (chatur/)        : 3 files
Shared Infrastructure  : 8 files
Documentation          : 2 files
─────────────────────────────────
Total                  : 26 files
```

## 🚀 Import Examples by Use Case

### Use Case 1: Process SMS Export

```typescript
import { ingestSmsExport } from "./runtime/dev";

const result = await ingestSmsExport("sms.json");
```

### Use Case 2: Chat with Mill

```typescript
import { ConversationalMill } from "./runtime/mill";
import { ConversationRouter } from "./runtime/shared";

const mill = new ConversationalMill(config);
const router = new ConversationRouter(mill, coach);
```

### Use Case 3: Get Financial Insights

```typescript
import { AnalystAgent } from "./runtime/param";
import { loadTransactions } from "./runtime/param";

const data = await loadTransactions();
const insights = await AnalystAgent.analyze(data);
```

### Use Case 4: Financial Coaching

```typescript
import { ConversationalCoach } from "./runtime/chatur";
import { CircuitBreaker } from "./runtime/shared";

const coach = new ConversationalCoach(config);
const breaker = new CircuitBreaker("coach-llm");
```

## 🎨 Design Principles

1. **Single Responsibility**: Each folder has one clear purpose
2. **No Duplication**: Shared code lives in `shared/`, not copied
3. **Clear Dependencies**: Agents depend on shared/, not each other
4. **Easy Navigation**: Find files by agent name quickly
5. **Clean Imports**: Index files provide clean export surfaces

## 📝 Maintenance Guidelines

### Adding New Agent Tool

```bash
# 1. Create file in agent folder
touch src/runtime/mill/new-tool.ts

# 2. Export from agent index
echo "export * from './new-tool.js';" >> src/runtime/mill/index.ts

# 3. Update this diagram
```

### Moving Tool to Shared

```bash
# If a tool is used by 2+ agents, move to shared/
mv src/runtime/mill/common-util.ts src/runtime/shared/
```

### Rule of Thumb

- **Agent folder**: Used by only ONE agent
- **Shared folder**: Used by TWO or more agents

## 🔍 Quick Reference

| Need to find...            | Look in... |
| -------------------------- | ---------- |
| User chat logic            | `mill/`    |
| SMS processing             | `dev/`     |
| Financial analysis         | `param/`   |
| Coaching advice            | `chatur/`  |
| Inter-agent communication  | `shared/`  |
| Error handling             | `shared/`  |
| CSV operations             | `shared/`  |
| Transaction categorization | `shared/`  |
