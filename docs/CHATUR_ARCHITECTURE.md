# Chatur Agent - Complete Architecture & Implementation Guide

**Date**: October 19, 2025  
**Version**: 2.0 (Context-Aware Coaching)  
**Status**: Fully Integrated with Query Routing System

---

## 🎯 Overview

**Chatur** is the Financial Coach and Strategic Advisor in the Convo Check multi-agent system. Unlike Mill (the data-focused chatbot), Chatur provides deep behavioral analysis, personalized coaching, and strategic financial guidance for gig workers.

---

## 🔑 Key Differentiation: Chatur vs Mill

| Aspect                | **Mill** (Chatbot)                                                         | **Chatur** (Coach)                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core Role**         | Data retrieval & presentation                                              | Behavioral analysis & coaching                                                                                                                                                              |
| **Primary Focus**     | WHAT happened                                                              | WHY it happened                                                                                                                                                                             |
| **Question Types**    | "What did I spend?"                                                        | "Why am I overspending?"                                                                                                                                                                    |
| **Personality**       | Witty, fun, meme-savvy                                                     | Thoughtful, empathetic, strategic                                                                                                                                                           |
| **Response Style**    | Quick, casual, emoji-heavy                                                 | Deep, reflective, insightful                                                                                                                                                                |
| **Output Format**     | Transaction lists, summaries                                               | Behavioral insights, action plans                                                                                                                                                           |
| **Example Response**  | "Yo! ₹1,500 on Swiggy this week 😅<br>You and food delivery = besties! 🍕" | "I see ₹1,500 on delivery this week.<br>Looking at your pattern, most orders<br>happen 7-9 PM on weekdays.<br>Often that's about convenience, not<br>cravings. Let's explore alternatives." |
| **Agent Interaction** | Direct data access, minimal coordination                                   | Coordinates with Mill, Param, Dev                                                                                                                                                           |
| **Tools**             | log_cash_transaction,<br>query_spending_summary,<br>get_factual_answer     | Context loading, LLM analysis,<br>proactive triggers,<br>**Financial calculators (NEW)**                                                                                                    |

### Personality Comparison Example

**Scenario**: User spent ₹1,500 on food delivery in one week

**Mill's Response:**

```
Whoa! ₹1,500 on food delivery this week? 🍕
Someone's living their best life! That's 5 orders -
you and Swiggy are basically besties now 😂
All logged and loaded! ✨
```

**Chatur's Response:**

```
I see ₹1,500 on food delivery this week - that's significant.
Help me understand: is this a typical week, or has something changed?

Looking at your pattern, delivery orders spike between 7-9 PM on weekdays.
Often that's about convenience and energy, not food cravings.

Would you be open to exploring what's driving this timing?
We might find easier, cheaper solutions that still honor your needs.
```

---

## 📊 Architecture Components

### 1. **Context Builder** (`context-builder.ts`)

**Purpose**: Loads comprehensive user context from Param's vector database

**Key Function**: `buildChaturUserContext(userId, options)`

**Returns**: `ChaturUserContext` with:

```typescript
{
  userId: string;
  profileGeneratedAt: string;

  // Financial Overview
  financial: {
    totalTransactions: number;
    totalSpent: number;
    totalEarned: number;
    currentBalance: number;
    averageTransactionSize: number;
    savingsRate: number; // 0-1
  };

  // Spending Patterns
  spendingPatterns: {
    topCategories: Array<{
      category: string;
      amount: number;
      percentage: number; // % of total spending
    }>;
    frequentMerchants: Array<{
      merchant: string;
      visits: number;
      totalSpent: number;
    }>;
    spendingByTime: {
      mostActiveTime: string; // "morning" | "afternoon" | "evening" | "night"
      mostActiveDay: string;
      peakSpendingHours: string[];
    };
    monthlyTrends: {
      currentMonth: number;
      lastMonth: number;
      trend: "increasing" | "decreasing" | "stable";
      changePercentage: number;
    };
  };

  // Behavioral Insights
  behavior: {
    riskFlags: {
      isOverspending: boolean;
      hasImpulseBuying: boolean;
      irregularIncome: boolean;
      lowSavings: boolean;
    };
    positiveHabits: string[];
    concerningPatterns: string[];
    opportunities: string[];
  };

  // Historical Context
  history: {
    habitProgression: Array<{
      date: string;
      habitType: string;
      pattern: string;
      suggestion: string;
    }>;
    recentInsights: HabitInsight[];
    keyMilestones: Array<{
      date: string;
      event: string;
      impact: string;
    }>;
  };

  // Recent Activity
  recentActivity: {
    last7Days: { transactions: number; spent: number; earned: number };
    last30Days: { transactions: number; spent: number; earned: number };
    significantTransactions: Array<{
      id: string;
      date: string;
      amount: number;
      type: string;
      category: string;
      merchant?: string;
    }>;
  };

  // Smart Recommendations
  recommendations: {
    immediate: string[]; // Urgent actions
    shortTerm: string[]; // This week/month
    longTerm: string[]; // Overall strategy
    conversationStarters: string[]; // Questions Chatur should ask
  };

  // Metadata
  metadata: {
    totalSnapshots: number;
    oldestSnapshot: string;
    newestSnapshot: string;
    dataQuality: "excellent" | "good" | "limited" | "insufficient";
    analysisConfidence: number; // 0-1
  };
}
```

**Data Sources**:

- Loads habit snapshots from `data/habit-snapshots/*.json` (Param's vector database)
- Aggregates financial data across all snapshots
- Calculates patterns, trends, and risk indicators
- Generates smart recommendations based on full context

---

### 2. **Personality Definition** (`chatur-personality.ts`)

**Purpose**: Defines Chatur's distinct coaching personality and approach

**Key Elements**:

#### System Prompt

```typescript
export const CHATUR_SYSTEM_PROMPT = `You are "Chatur", the Financial Coach 
and Strategic Advisor for gig workers...

YOUR UNIQUE IDENTITY:
- Mill shows WHAT happened → You explain WHY it matters
- Mill is witty and quick → You are deep and strategic
- Mill uses emojis freely → You use them thoughtfully
- Mill presents data → You create insights
- Mill is a friend → You are a coach

YOUR PERSONALITY:
- 🧠 Strategic Thinker: You see patterns others miss
- 💙 Empathetic Guide: You understand financial stress is real
- 🎯 Goal-Oriented: You help users set and achieve financial milestones
- 🌱 Growth Mindset: You celebrate progress, not perfection
- 🔍 Curious Investigator: You ask "why" to understand root causes

YOUR COACHING APPROACH:
1. Context-First: Always load full user context before responding
2. Ask Before Telling: Guide through questions, not lectures
3. Data-Informed, Not Data-Driven: Use data but add interpretation
4. Progressive Coaching: Meet users where they are
5. Behavioral Psychology: Understand WHY people spend
...`;
```

#### Query Classification Functions

```typescript
// Recognizes coaching queries
export function isChaturQuery(query: string): boolean {
  // Returns true for:
  // - "why", "how can", "should i"
  // - "advice", "help me", "recommend"
  // - "habit", "pattern", "overspending"
  // - "save", "budget", "improve"
  // - "worried", "stressed", "broke"
}

// Recognizes data queries (should go to Mill)
export function isMillQuery(query: string): boolean {
  // Returns true for:
  // - "show", "list", "display"
  // - "what did i", "yesterday"
  // - "transactions", "log", "spent"
}
```

#### Example Coaching Scenarios

**Overspending Analysis**:

```
Query: "Why am I always broke?"

Response: I've reviewed your financial journey, and I can see why
you're feeling this way. Let me share what I'm observing:

Your spending has exceeded your income for the last 3 weeks. The main
driver is food & dining at 43% of your budget (₹5,400 last month),
with most purchases happening between 7-9 PM.

Here's what stands out: you're not reckless - you're working hard with
irregular income, and convenience spending fills a real need. But it's
creating a cycle.

Let's break this down together:
1. What's driving those evening orders? Tiredness? Time pressure?
2. Would you be open to a hybrid approach - maybe 2 home meals + 1 treat per week?
3. Your income varies (₹10k-15k), so we need a buffer strategy too.

Small shifts can change this. What feels most doable to start with?
```

**Savings Strategy**:

```
Query: "How can I save more money?"

Response: Great question - the fact that you're asking shows you're
ready for change. Let me look at your situation:

Current savings rate: -5% (spending ₹500 more than earning)
Income pattern: Irregular (₹8k-14k per month)
Top expense: Food & Dining (40%)

For gig workers, traditional "save 20%" advice doesn't work. Here's
what I recommend:

Phase 1 (This Month): Stabilize
- Track every rupee for 2 weeks (awareness first)
- Identify one category to reduce by 20%
- Goal: Break even (₹0 savings is progress from -₹500!)

Phase 2 (Next Month): Build Buffer
- Save ₹100/week in good income weeks
- Target: ₹400 emergency buffer

Phase 3 (Month 3+): Grow
- Aim for 10% savings rate
- Build to 1 month's expenses

What feels achievable for Phase 1?
```

**Redirect to Mill**:

```
Query: "Show me my transactions from yesterday"

Response: That's a data query - Mill is the expert for pulling
specific transactions! Let me connect you with Mill who can show
you exactly what you spent yesterday.

But here's a thought: once you see the numbers, would you like me
to help you understand if there are any patterns we should address?
I'm here when you're ready to dig deeper into the "why" behind
the spending. 📊
```

---

### 3. **Coordinator** (`chatur-coordinator.ts`)

**Purpose**: Orchestrates Chatur's coaching with other agents and query routing

**Key Function**: `handleCoachingQuery(userQuery, userId, routing, options)`

**Parameters**:

```typescript
{
  userQuery: string;          // User's question
  userId: string;             // User identifier
  routing?: QueryRouting;     // From query-router.ts (optional)
  options: {
    sessionId?: string;       // For conversation continuity
    csvPath?: string;         // Custom data path
  }
}
```

**Returns**:

```typescript
{
  response: string;                    // Coaching response
  session: ChaturCoachingSession;      // Session state
  dataUsed?: {
    transactions?: TransactionSummary; // Data from Mill
    insights?: HabitInsight[];         // Data from Param
  };
  needsMillData?: boolean;
  millQuery?: string;
}
```

**Processing Flow**:

```
1. Load or create coaching session
   ↓
2. Check if Mill data needed (from routing)
   ↓
3. If needed: Fetch transaction data from Mill
   ↓
4. Load full user context from Param's vector database
   ↓
5. Generate coaching response with LLM
   ↓
6. Update conversation history
   ↓
7. Return response + session state
```

**Agent Coordination**:

```typescript
// With Mill (Data Retrieval)
if (
  routing?.dataNeeded.type === "raw_transactions" ||
  routing?.dataNeeded.type === "mixed"
) {
  transactionData = await queryTransactions(filters);
  // Then analyze this data for coaching
}

// With Param (Habit Intelligence)
const userContext = await buildChaturUserContext(userId);
// Loads from Param's vector database

// With Dev (Transaction Monitoring)
export async function checkCoachingTriggers(userId, newTransaction) {
  // Called when Dev processes new transaction
  // Returns coaching intervention if needed
}
```

**Proactive Coaching Triggers**:

```typescript
Trigger 1: Budget Threshold (category > 40% of spending)
→ "I notice food is now 43% of your spending. Want to discuss?"

Trigger 2: Overspending Risk (spending > income)
→ "Quick check-in: You're spending more than earning lately.
   This ₹500 expense adds to the pattern. Want to create
   a quick action plan together?"

Trigger 3: Impulse Buying (3+ transactions in short period)
→ "I'm noticing frequent small purchases this week (10 transactions).
   This could be impulse buying. Would you be open to trying
   the 24-hour rule for non-essentials?"
```

---

## 🔄 Integration with Query Routing System

### How It Works

Chatur fully supports the new query classification system from `mill/query-router.ts`:

```typescript
// Query Router determines agent and data needs
const routing = await routeQuery(userQuery);
// Returns: { targetAgent, dataNeeded, shouldEscalate, ... }

// If targetAgent === "chatur"
const result = await handleCoachingQuery(
  userQuery,
  userId,
  routing // ✅ Routing info passed to Chatur
);
```

### Query Flow Examples

#### Pure Coaching Query

```
User: "Why am I overspending?"
↓
query-router.ts → {
  targetAgent: "chatur",
  dataNeeded.type: "coaching_advice"
}
↓
chatur-coordinator.ts → handleCoachingQuery()
↓
Loads context from buildChaturUserContext()
↓
Generates strategic coaching response
✓ "I've analyzed your patterns and see 3 key factors..."
```

#### Mixed Query (Data + Coaching)

```
User: "Show my food spending and tell me if it's too much"
↓
query-router.ts → {
  targetAgent: "mill",
  dataNeeded.type: "mixed",
  shouldEscalate: true
}
↓
Mill handles data first → "You spent ₹5,400 on food (43%)"
↓
Escalates to chatur-coordinator.ts with transaction data
↓
Chatur analyzes: "43% is high for your income level.
Most happens 7-9 PM. Let's explore alternatives..."
```

#### Data-Only Query (Redirect to Mill)

```
User: "Show my transactions from yesterday"
↓
query-router.ts → {
  targetAgent: "mill",
  dataNeeded.type: "raw_transactions"
}
↓
chatur-coordinator.shouldRedirectToMill() → TRUE
↓
Chatur responds: "That's Mill's specialty! Let me connect you.
But once you see the numbers, I'm here to help understand them."
```

---

## 🧠 Coaching Framework

### Phase-Based Approach

Chatur uses a 4-phase coaching framework:

#### Phase 1: Understand

```
1. Load user context (buildChaturUserContext)
2. Identify the core concern
3. Ask clarifying questions
4. Acknowledge their feelings
```

**Example**:

```
"I see you're concerned about overspending. Help me understand -
is this a recent change, or has it been building over time?
What's making you worried right now?"
```

#### Phase 2: Analyze

```
1. Show what data reveals (with Mill's help if needed)
2. Identify patterns they may not see
3. Connect behavior to outcomes
4. Highlight both risks AND opportunities
```

**Example**:

```
"Looking at your data, I see a pattern:
- Food spending: 43% (₹5,400/month)
- Peak time: 7-9 PM on weekdays (60% of orders)
- Income: Irregular (₹8k-14k)

The risk: You're spending more than earning 3 weeks out of 4
The opportunity: Most spending is time-based, not need-based
If we solve the 7-9 PM convenience issue, we can reduce
food costs by 30% without sacrificing quality of life."
```

#### Phase 3: Strategize

```
1. Co-create goals with user
2. Break down into actionable steps
3. Address potential obstacles
4. Set success metrics
```

**Example**:

```
"Let's create a 3-phase plan:

Phase 1 (This Week): Awareness
- Track when you order delivery and why
- Goal: Identify your top 3 triggers

Phase 2 (Next 2 Weeks): Experiment
- Pre-cook 2 meals on Sunday
- Keep quick snacks handy for 7-9 PM
- Allow 1 delivery/week as treat

Phase 3 (Month 2): Optimize
- Reduce to ₹3,600 food budget (from ₹5,400)
- Save the ₹1,800 difference
- Review and adjust

Which phase feels most doable to start?"
```

#### Phase 4: Support

```
1. Regular check-ins on progress
2. Celebrate wins (even small ones)
3. Adjust strategy based on results
4. Maintain accountability without judgment
```

**Example**:

```
"Week 1 update: You spent ₹850 on food - on track!

I noticed you avoided impulse orders on Tuesday and Thursday.
What helped you stick with it those days? Let's build on that.

One slip-up on Friday (₹300 delivery), but that's learning,
not failure. What triggered it? How can we prepare better
next Friday?"
```

---

## 🎯 Use Cases & Implementation

### Use Case 1: Overspending Intervention

**Scenario**: User's spending exceeds income for 3+ weeks

**Implementation**:

```typescript
// Automatic trigger from Dev agent
Dev.on("newTransaction", async (tx) => {
  const context = await buildChaturUserContext(tx.userId);

  if (context.behavior.riskFlags.isOverspending) {
    const trigger = await checkCoachingTriggers(tx.userId, tx);

    if (trigger.shouldTrigger) {
      // Send proactive message
      await sendCoachingMessage(tx.userId, trigger.message);
    }
  }
});
```

**Chatur's Response**:

```
"Quick check-in: I notice you're spending more than you're earning
lately. Your last 3 weeks have been:
- Week 1: -₹420 (spent ₹420 more than earned)
- Week 2: -₹680
- Week 3: -₹350 (this week so far)

The main driver is food & dining (₹5,400/month = 43% of income).

This isn't sustainable, but it's fixable. Want to create a quick
action plan together? I have some ideas based on your spending
patterns."
```

---

### Use Case 2: Savings Goal Creation

**Scenario**: User asks "How can I save more?"

**Implementation**:

```typescript
const result = await handleCoachingQuery("How can I save more money?", userId, {
  targetAgent: "chatur",
  dataNeeded: { type: "coaching_advice" },
});
```

**Chatur's Response**:

```
"Great question! Let me look at your situation:

Current State:
- Savings rate: -5% (₹500 deficit/month)
- Income: Irregular (₹8k-14k)
- Top expense: Food (40%)

For gig workers, traditional advice doesn't work. Here's my recommendation:

Immediate (This Month):
1. Track everything for 2 weeks (build awareness)
2. Pick ONE category to reduce by 20%
3. Goal: Break even (₹0 savings = progress!)

Short-term (Next Month):
1. Save ₹100/week in good income weeks
2. Build ₹400 emergency buffer
3. Create income variance cushion

Long-term (3+ months):
1. Aim for 10% savings rate
2. Build to 1 month's expenses buffer
3. Start thinking about investment

What feels achievable for the immediate phase?"
```

---

### Use Case 3: Category Budget Analysis

**Scenario**: User asks "Am I spending too much on food?"

**Implementation**:

```typescript
// Mixed query: needs data + coaching
const routing = await routeQuery("Am I spending too much on food?");
// Returns: { targetAgent: "mill", type: "mixed", shouldEscalate: true }

// Mill fetches data first
const foodData = await queryTransactions({ category: "Food & Dining" });

// Then escalate to Chatur with data
const coaching = await handleCoachingQuery(
  "Am I spending too much on food?",
  userId,
  routing,
  { foodData }
);
```

**Chatur's Response**:

```
"Let's look at your food spending together:

Your Numbers:
- Food & Dining: ₹5,400/month (43% of income)
- Breakdown: ₹3,200 delivery + ₹2,200 groceries
- Pattern: Peak delivery 7-9 PM weekdays

Industry Guideline:
- Healthy range: 25-30% for your income level
- Your 43% is above that

But here's the context: You're a gig worker with irregular hours.
Convenience isn't luxury - it's a tool. The question isn't "should
you cut food spending?" but "how can you meet the same need cheaper?"

Ideas:
1. Meal prep Sunday for weeknights (save ₹1,500)
2. Keep quick snacks for 7-9 PM hunger (save ₹800)
3. Allow 1 delivery/week as treat (maintain sanity)

This could get you to 30% (₹3,600) without sacrificing convenience.
Thoughts?"
```

---

## 📈 Smart Recommendations System

Chatur generates context-aware recommendations at multiple time horizons:

### Immediate Actions (Urgent)

Triggered when:

- `behavior.riskFlags.isOverspending === true`
- `financial.currentBalance < 0`
- Category >50% of income

Example:

```
"Review and pause non-essential spending this week"
"Focus on income-generating activities to balance out"
```

### Short-Term (This Week/Month)

Triggered when:

- `behavior.riskFlags.hasImpulseBuying === true`
- Top category >40% of spending
- Irregular spending pattern detected

Example:

```
"Try the 24-hour rule: wait before making non-essential purchases"
"Set a budget for Food & Dining - it's 43% of your spending"
```

### Long-Term (Overall Strategy)

Triggered when:

- `financial.savingsRate < 0.1`
- `behavior.riskFlags.irregularIncome === true`
- No emergency fund detected

Example:

```
"Build an emergency fund: aim to save 10-15% of income"
"Create a buffer for irregular income months"
```

### Conversation Starters

Generated based on context to guide coaching:

```typescript
if (behavior.riskFlags.isOverspending) {
  → "I noticed you're spending more than earning. What's driving this?"
}

if (topCategory.percentage > 40) {
  → "You spend a lot on ${category}. Is this intentional or
     would you like to reduce it?"
}

if (financial.savingsRate > 0.1) {
  → "You're doing well with savings! What's your next financial goal?"
}
```

---

## 🔧 Technical Implementation Details

### Directory Structure

```
src/runtime/chatur/
├── coach-agent.ts              # Original briefing mode
├── conversational-coach.ts     # Interactive coaching sessions
├── context-builder.ts          # NEW: Vector database loader
├── chatur-personality.ts       # NEW: Personality & examples
├── chatur-coordinator.ts       # NEW: Query routing integration
└── index.ts                    # Exports
```

### Key Dependencies

```typescript
// Data Sources
import { buildChaturUserContext } from "./context-builder.js";
import { queryTransactions } from "../mill/transaction-reader.js";
import { runAnalyst, HabitInsight } from "../param/analyst-agent.js";

// AI
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { getAgentConfig } from "../../config.js";

// Routing
import type { QueryRouting } from "../mill/query-router.js";
```

### Configuration

Chatur uses `agent4` config (Coach):

```typescript
const { apiKey, model } = getAgentConfig("agent4");
// model: "gemini-2.0-flash-exp"
```

---

## 🚀 Integration Guide

### Step 1: Import Chatur Components

```typescript
import {
  handleCoachingQuery,
  shouldRedirectToMill,
  checkCoachingTriggers,
} from "./runtime/chatur/chatur-coordinator.js";

import { buildChaturUserContext } from "./runtime/chatur/context-builder.js";
```

### Step 2: Handle Coaching Queries

```typescript
// After query routing
if (routing.targetAgent === "chatur") {
  const result = await handleCoachingQuery(userQuery, userId, routing, {
    sessionId: currentSession?.id,
  });

  return result.response;
}
```

### Step 3: Set Up Proactive Triggers

```typescript
// In Dev agent's transaction processing
Dev.on("transactionProcessed", async (tx) => {
  const trigger = await checkCoachingTriggers(tx.userId, tx);

  if (trigger.shouldTrigger) {
    await notifyUser(tx.userId, trigger.message);
  }
});
```

### Step 4: Enable Context Loading

```typescript
// Before coaching session starts
const userContext = await buildChaturUserContext(userId);

// Now Chatur has access to:
// - All habit snapshots from Param
// - Financial overview
// - Spending patterns
// - Behavioral insights
// - Smart recommendations
```

---

## 📊 Data Flow Diagram

```
User Query: "Why am I overspending?"
    ↓
┌─────────────────────────┐
│  Query Router           │
│  (mill/query-router.ts) │
└─────────────────────────┘
    ↓
    ├─ targetAgent: "chatur"
    ├─ dataNeeded.type: "coaching_advice"
    └─ confidence: "high"
    ↓
┌─────────────────────────────────┐
│  Chatur Coordinator             │
│  (chatur/chatur-coordinator.ts) │
└─────────────────────────────────┘
    ↓
    ├─ Load Session (or create new)
    ↓
┌─────────────────────────────────┐
│  Context Builder                │
│  (chatur/context-builder.ts)    │
└─────────────────────────────────┘
    ↓
    ├─ Load habit snapshots from Param
    ├─ Aggregate financial data
    ├─ Calculate patterns & trends
    ├─ Identify risk flags
    └─ Generate recommendations
    ↓
┌─────────────────────────────────┐
│  LLM (Gemini 2.0 Flash)         │
│  with CHATUR_SYSTEM_PROMPT      │
└─────────────────────────────────┘
    ↓
    ├─ System: Chatur personality prompt
    ├─ User context (full profile)
    ├─ Conversation history
    └─ Current query
    ↓
┌─────────────────────────────────┐
│  Coaching Response              │
└─────────────────────────────────┘
    ↓
"I've analyzed your patterns and see 3 key factors driving
overspending: 1) Food delivery 43% of budget (mostly 7-9 PM),
2) Irregular income creating stress spending, 3) No emergency buffer.
Let's tackle these one at a time..."
```

---

## ⚡ Performance Considerations

### Context Loading

- Snapshots cached per session (not reloaded for every message)
- Maximum 50 snapshots loaded (configurable via `maxSnapshots`)
- Old snapshots filtered out if >90 days

### LLM Calls

- One LLM call per coaching response
- Prompt optimized to include only relevant context
- Circuit breaker pattern implemented for failures

### Memory Management

- Sessions stored in-memory (TODO: persist to disk)
- Automatic cleanup of abandoned sessions after 1 hour
- Conversation history limited to last 20 messages

---

## 🧪 Testing

### Test Coaching Query

```typescript
import { handleCoachingQuery } from "./runtime/chatur/chatur-coordinator.js";

const result = await handleCoachingQuery(
  "Why am I overspending?",
  "user123",
  undefined,
  { csvPath: "./data/transactions.csv" }
);

console.log(result.response);
```

### Test Context Loading

```typescript
import { buildChaturUserContext } from "./runtime/chatur/context-builder.js";

const context = await buildChaturUserContext("user123");

console.log("Data Quality:", context.metadata.dataQuality);
console.log("Savings Rate:", context.financial.savingsRate);
console.log("Top Category:", context.spendingPatterns.topCategories[0]);
console.log("Risk Flags:", context.behavior.riskFlags);
```

### Test Proactive Triggers

```typescript
import { checkCoachingTriggers } from "./runtime/chatur/chatur-coordinator.js";

const trigger = await checkCoachingTriggers("user123", {
  amount: 500,
  type: "expense",
  category: "Food & Dining",
  merchant: "Swiggy",
});

if (trigger.shouldTrigger) {
  console.log("Trigger Message:", trigger.message);
}
```

### Test Financial Calculations (NEW)

```typescript
import {
  calculateSavingsGoal,
  calculateDailyBudget,
  checkAffordability,
} from "./tools/financial-calculator.js";

// Test savings goal
const savingsGoal = calculateSavingsGoal(10000, 2340, 6, 20000);
console.log("Daily savings needed:", savingsGoal.dailyRequired); // ₹43

// Test daily budget
const dailyBudget = calculateDailyBudget(20000, 10000, 4000);
console.log("Daily spending limit:", dailyBudget.dailyBudget); // ₹200

// Test affordability
const affordability = checkAffordability(15000, 20000, 8000, 12000);
console.log("Recommendation:", affordability.recommendation); // "save_first"
```

**Quick Test**:

```bash
node test-calculations.js
```

---

## 🎓 Best Practices

### 1. Always Load Context First

```typescript
// ✅ Good
const context = await buildChaturUserContext(userId);
const response = await generateCoachingResponse(query, context);

// ❌ Bad
const response = await generateCoachingResponse(query);
// Missing context = generic advice
```

### 2. Use Appropriate Tone

```typescript
// ✅ Chatur (Thoughtful)
"I notice your food spending is high. What's driving that?";

// ❌ Mill-style (Casual)
"Whoa! Food spending off the charts! 🚀";
```

### 3. Coordinate with Mill for Data

```typescript
// ✅ Good
const data = await Mill.queryTransactions(filters);
const coaching = await Chatur.analyze(data);

// ❌ Bad
const coaching = await Chatur.analyze();
// Chatur shouldn't fetch raw data itself
```

### 4. Respect User Autonomy

```typescript
// ✅ Collaborative
"Would you be open to exploring alternatives?";
"What feels most doable to start with?";

// ❌ Prescriptive
"You must stop ordering delivery.";
"You should cut food spending by 50%.";
```

---

## 🧮 Financial Calculator Integration (NEW)

### Overview

**Version**: 3.0 (October 19, 2025)  
**Module**: `src/tools/financial-calculator.ts`  
**Status**: ✅ Production Ready

Chatur now includes **mathematically accurate financial calculators** that automatically trigger for calculation-based queries. These provide exact numbers that Chatur translates into natural, actionable coaching advice.

### Key Capabilities

#### 1. Savings Goal Calculator

**Purpose**: Calculate daily/weekly/monthly savings needed to reach a financial goal

**Function**: `calculateSavingsGoal(targetAmount, currentSavings, timeframeMonths, monthlyIncome)`

**Returns**:

```typescript
{
  targetAmount: number;
  currentSavings: number;
  timeframeMonths: number;
  totalNeeded: number;              // Amount still needed
  monthlyRequired: number;          // Per month
  weeklyRequired: number;           // Per week
  dailyRequired: number;            // Per day
  isAchievable: boolean;            // <30% of income
  recommendedAdjustment?: {         // If not achievable
    type: "increase_timeframe" | "reduce_target" | "increase_income";
    suggestion: string;
  }
}
```

**Example**:

```typescript
const result = calculateSavingsGoal(10000, 2340, 6, 20000);
// Daily: ₹43, Weekly: ₹295, Monthly: ₹1,277
// Achievable: Yes (6.4% of income)
```

**Triggers on**:

- "How much should I save daily to reach X?"
- "Save ₹200 per month, how much daily?"
- "Reach ₹10,000 in 6 months"

---

#### 2. Daily Budget Calculator

**Purpose**: Calculate daily spending budget based on income, fixed expenses, and savings goals

**Function**: `calculateDailyBudget(monthlyIncome, fixedExpenses, savingsGoal)`

**Returns**:

```typescript
{
  dailyBudget: number; // Per day
  weeklyBudget: number; // Per week
  monthlyDiscretionary: number; // Total available
  breakdown: {
    income: number;
    fixed: number;
    savings: number;
    discretionary: number; // What's left
  }
}
```

**Example**:

```typescript
const result = calculateDailyBudget(20000, 10000, 4000);
// Daily: ₹200, Weekly: ₹1,385
// Discretionary: ₹6,000
```

**Triggers on**:

- "How much can I spend daily?"
- "What's my daily budget?"
- "Spending limit if I save ₹4,000/month"

---

#### 3. Budget Allocation (50/30/20 Rule)

**Purpose**: Recommend income allocation using standard financial guidelines

**Function**: `calculateBudgetAllocation(monthlyIncome)`

**Returns**:

```typescript
{
  income: number;
  needs: number; // 50% - essentials
  wants: number; // 30% - lifestyle
  savings: number; // 20% - future
  emergencyFundMin: number; // 3 months expenses
  emergencyFundMax: number; // 6 months expenses
}
```

**Example**:

```typescript
const result = calculateBudgetAllocation(25000);
// Needs: ₹12,500, Wants: ₹7,500, Savings: ₹5,000
// Emergency fund: ₹75,000-₹1,50,000
```

**Triggers on**:

- "How should I allocate my income?"
- "Budget breakdown for ₹25,000"
- "50/30/20 rule for my salary"

---

#### 4. Affordability Check

**Purpose**: Assess whether a purchase is financially sound

**Function**: `checkAffordability(itemCost, monthlyIncome, currentSavings, monthlyExpenses)`

**Returns**:

```typescript
{
  itemCost: number;
  percentOfIncome: number; // Purchase as % of income
  percentOfSavings: number; // As % of current savings
  canAffordNow: boolean; // <10% income + no emergency dip
  monthsToSave: number; // If need to save first
  impactOnEmergencyFund: boolean;
  recommendation: "buy_now" | "save_first" | "reconsider";
  reason: string;
}
```

**Example**:

```typescript
const result = checkAffordability(15000, 20000, 8000, 12000);
// Recommendation: "save_first"
// Reason: "Would dip emergency fund. Save for 3 months (₹2,334/month)"
```

**Triggers on**:

- "Can I afford ₹15,000 phone?"
- "Should I buy this?"
- "Is ₹5,000 purchase okay?"

---

#### 5. Compound Interest Calculator

**Purpose**: Calculate investment growth with compound interest

**Function**: `calculateCompoundInterest(principal, annualRate, years, monthlyContribution)`

**Returns**:

```typescript
{
  principal: number;
  rate: number;
  timeYears: number;
  monthlyContribution: number;
  futureValue: number;        // Final amount
  totalContributed: number;   // All deposits
  totalInterest: number;      // Interest earned
  monthlyBreakdown?: Array<{  // Optional
    month: number;
    balance: number;
    interestEarned: number;
  }>;
}
```

**Example**:

```typescript
const result = calculateCompoundInterest(10000, 0.08, 5, 1000);
// Future value: ₹94,096
// Total contributed: ₹70,000
// Total interest: ₹24,096
```

---

### Integration with Chatur's Coaching

#### Automatic Detection

```typescript
// In chatur-coordinator.ts
export function needsFinancialCalculation(query: string): boolean {
  const patterns = [
    "how much",
    "calculate",
    "daily",
    "weekly",
    "monthly",
    "save",
    "spend",
    "afford",
    "reach",
    "achieve",
    "budget",
  ];
  return patterns.some((p) => query.toLowerCase().includes(p));
}
```

#### Parameter Extraction

```typescript
export function extractCalculationParams(
  query: string,
  context: ChaturUserContext
): {
  type: "savings_goal" | "daily_budget" | "affordability" | "budget_allocation";
  params: Record<string, any>;
};
```

**Handles**:

- Amount parsing: "₹10,000", "10k", "rs 200"
- Timeframe parsing: "6 months", "2 weeks", "1 year"
- Context injection: Uses user's actual income, expenses, savings

#### Natural Language Integration

**Flow**:

```
User Query: "How much should I save daily to reach ₹10,000 in 6 months?"
  ↓
needsFinancialCalculation() → TRUE
  ↓
extractCalculationParams() → { type: "savings_goal", params: {...} }
  ↓
performCalculation() → Exact mathematical result
  ↓
Result added to Chatur's prompt context
  ↓
Chatur receives: "=== ACCURATE CALCULATION RESULT ===
                  Target: ₹10,000
                  Daily: ₹43, Weekly: ₹295, Monthly: ₹1,277
                  Achievable: Yes (6% of income)"
  ↓
Chatur responds naturally:
"Great goal! To reach ₹10,000 in 6 months, you'd need to save about
₹43 per day. That's roughly the cost of one auto ride or two cups of
chai. Looking at your spending, you spend ₹1,800/month on dining out.
If we redirect 70% of that, you'd hit your goal while still enjoying
occasional treats. This is definitely achievable..."
```

### Prompt Enhancement

Chatur's system prompt now includes:

```
**USING ACCURATE CALCULATIONS:**

✅ DO:
- Use EXACT numbers from calculations in responses
- Translate math into natural language
- Connect calculations to user's habits
- Make numbers relatable
- Provide context for percentages

❌ DON'T:
- Ignore calculations and make up numbers
- Dump math without explanation
- Use technical jargon
- Present numbers without connecting to situation
```

### Real Example

**User Query**: "I want to save ₹200 per month, how much daily?"

**Calculation Output**:

```
📊 Savings Goal Calculation:
Target: ₹200
Timeframe: 1 month

Required Savings:
• Daily: ₹7
• Weekly: ₹46
• Monthly: ₹200

✅ Achievable: Only 1.3% of income
```

**Chatur's Response**:

> "₹200/month—I LOVE this! You're starting small and realistic. That's exactly the right approach.
>
> **The Math**: ₹7 daily (literally one chai + biscuit), ₹46 weekly (one less outside meal)
>
> **This is so achievable!** Looking at your spending, you spend ₹200-300 daily on average. Saving ₹7 means spending ₹193 instead of ₹200—that's like skipping one snack or auto ride.
>
> **3 Easy Ways to Find ₹7 Daily**:
>
> 1. **The Chai Strategy**: Local stall (₹10) vs café (₹40) = ₹30 saved, use ₹7
> 2. **The Walk Method**: Walk short distances instead of auto
> 3. **The Cook Once Strategy**: Make dinner at home 1 extra day/week = ₹50 saved
>
> **Power Move**: Auto-transfer ₹50/week every Monday. You'll hit ₹200/month without thinking!
>
> Want to try this for 2 weeks and see how it feels?"

### Calculation Accuracy

✅ **Mathematically Precise**:

- Standard financial formulas
- Proper rounding (only for display)
- Edge case handling (zero income, negative balance, infinite payoff)

✅ **Context-Aware**:

- Uses actual user data from Param's vector database
- Adjusts for irregular gig income patterns
- Considers emergency fund requirements
- Factors in spending patterns

✅ **Validated**:

- Comprehensive test suite (`test-calculations.js`)
- Comparison with standard financial calculators
- Edge cases covered

### Testing

**Run all calculation tests**:

```bash
node test-calculations.js
```

**Test output includes**:

- Savings goal: ₹10,000 in 6 months → ₹43/day ✅
- Daily budget: Save ₹4,000/month → ₹200/day ✅
- Budget allocation: ₹25,000 → 50/30/20 breakdown ✅
- Affordability: ₹15,000 phone → "save_first" ✅
- Small goal: ₹200/month → ₹7/day (1.3% income) ✅

---

## 🔮 Future Enhancements

### Planned Features

1. **Session Persistence**: Save coaching sessions to disk
2. **Goal Tracking**: Monitor user progress on action plans
3. **A/B Testing**: Test different coaching approaches
4. **Multi-language Support**: Hindi/English mixed responses
5. **Voice Mode**: Voice-based coaching for accessibility

### Research Areas

1. **Behavioral Economics**: Integrate nudge theory
2. **Gamification**: Reward systems for financial goals
3. **Predictive Analytics**: Forecast spending based on patterns
4. **Peer Comparison**: Anonymous benchmarking (with consent)

---

## 📚 References

### Related Documentation

- `MILL_ARCHITECTURE.md` - Mill agent (data & presentation)
- `PARAM_ARCHITECTURE.md` - Param agent (habit analysis)
- `QUERY_ROUTING.md` - Query classification system
- `VECTOR_DATABASE.md` - Habit snapshot structure

### Code Files

- `src/runtime/chatur/context-builder.ts` - Context loading
- `src/runtime/chatur/chatur-personality.ts` - Personality definition
- `src/runtime/chatur/chatur-coordinator.ts` - Main orchestration
- `src/runtime/mill/query-router.ts` - Query routing integration
- `src/runtime/param/habit-tracker.ts` - Vector database creation

---

## ✅ Summary

**Chatur is:**

- ✓ A strategic financial coach (NOT a data presenter)
- ✓ Thoughtful, empathetic, and goal-oriented
- ✓ Context-aware (loads full user profile from vector database)
- ✓ Integrated with query routing system
- ✓ Coordinated with Mill (data), Param (habits), Dev (monitoring)
- ✓ Proactive (triggers interventions automatically)
- ✓ Progressive (meets users where they are)

**Chatur is NOT:**

- ✗ A chatbot like Mill (different personality & purpose)
- ✗ A data retrieval system (delegates to Mill)
- ✗ Prescriptive (collaborative, not commanding)
- ✗ Generic (uses full context for personalized coaching)

---

**Last Updated**: October 19, 2025  
**Maintainer**: Convo Check Development Team  
**Status**: Production Ready ✅
