# Mill Agent - Smart Transaction Query System

## 🎯 Overview

Mill now has **intelligent query routing** that distinguishes between:

1. **Data retrieval queries** (Mill handles directly)
2. **Coaching queries** (Routes to Chatur)
3. **Mixed queries** (Mill shows data + offers Chatur escalation)

## ✅ What Was Built

### 1. **Transaction Reader** (`transaction-reader.ts`)

- Direct CSV reading (no Dev agent interaction)
- Filters by date, type, amount, merchant, category
- Helper functions for common queries:
  - `getYesterdayTransactions()`
  - `getLastNDaysTransactions(days)`
  - `getMonthTransactions(year, month)`
  - `getCurrentMonthTransactions()`
  - `getLastMonthTransactions()`
- Pretty formatting for user presentation

### 2. **Query Router** (`query-router.ts`)

- LLM-powered query understanding
- Distinguishes Mill vs Chatur queries
- Classifies data type needed:
  - `raw_transactions` - Factual transaction lists
  - `habit_analysis` - Behavioral patterns (needs Param)
  - `spending_patterns` - Aggregate/trend analysis
  - `coaching_advice` - Recommendations and guidance
  - `mixed` - Both data and coaching
- Fallback pattern matching when LLM unavailable

### 3. **Transaction Query Handler** (`transaction-query-handler.ts`)

- Parses user intent from natural language
- Maps to appropriate date ranges
- Fetches filtered transaction data
- Formats results for user presentation

### 4. **Integrated Query Handler** (`integrated-query-handler.ts`)

- **Smart routing logic:**
  - Pure data queries → Mill handles, no escalation
  - Pure coaching queries → Redirects to Chatur immediately
  - Mixed queries → Mill shows data FIRST, then offers Chatur
  - Habit analysis queries → Shows basic data + escalates to Chatur
- Provides context to Chatur when escalating

## 🔄 Query Flow Examples

### Example 1: Pure Data Query (Mill Only)

**User:** "show me my transactions last month"

**Mill's Response:**

```
✅ Routes to: MILL
✅ Data Type: raw_transactions
✅ Escalation: NO

📊 Transaction Summary (2025-09-18 to 2025-09-30)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Transactions: 5
💸 Total Debits: 40.00
💰 Total Credits: 25.00
📈 Net Amount: -15.00

[Transaction list...]
```

### Example 2: Pure Coaching Query (Chatur Redirect)

**User:** "why am I spending so much money?"

**Mill's Response:**

```
✅ Routes to: CHATUR
✅ Data Type: coaching_advice
✅ Escalation: YES

I understand you're looking for guidance.

This type of question is best handled by Chatur, our financial coach who specializes in:
- Understanding spending habits
- Providing personalized advice
- Helping with budgeting strategies
- Analyzing behavioral patterns

Would you like me to connect you with Chatur?
```

### Example 3: Mixed Query (Mill + Chatur Offer)

**User:** "show me my expenses this month and tell me if I'm overspending"

**Mill's Response:**

```
✅ Routes to: MILL (with escalation)
✅ Data Type: spending_patterns
✅ Escalation: YES

📊 Transaction Summary (2025-10-02 to 2025-10-11)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Transactions: 8
💸 Total Debits: 339.00
💰 Total Credits: 668.00
📈 Net Amount: 329.00

[Transaction list...]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 **I've shown you the raw data above.**

For deeper analysis of your spending behavior, Chatur can help with:
- ✅ Habit pattern analysis (from Param's tracking)
- ✅ Overspending detection and alerts
- ✅ Personalized budget recommendations
- ✅ Behavioral insights and trends

Would you like me to connect you with Chatur for a detailed analysis?
```

## 🎓 Classification Logic

### Mill Handles (Data Queries)

- "Show me..." / "List..." / "Display..." / "What..."
- Specific time periods (yesterday, last month, this week)
- Transaction lookups by merchant/category
- Amount filters (over X, under Y)

### Chatur Handles (Coaching Queries)

- "Why..." / "How can I..." / "Should I..."
- "Help me..." / "Advice..." / "Recommend..."
- "Am I overspending..." / "Is this too much..."
- Pattern analysis / Habit questions

### Mixed Approach

- "Show me X AND tell me Y"
- "What did I spend AND is it too much"
- Data request + evaluation request

## 🚀 Usage

### Test Script

```bash
# Data query
node scripts/test-mill-query.js "list all my transactions this month"

# Coaching query
node scripts/test-mill-query.js "why am I spending so much?"

# Mixed query
node scripts/test-mill-query.js "show my expenses and tell me if I'm overspending"
```

### Programmatic Usage

```typescript
import { processUserQuery } from "./runtime/mill/integrated-query-handler.js";

const result = await processUserQuery("show me my transactions yesterday", {
  showRouting: true,
});

console.log(result.response);

if (result.escalationNeeded) {
  // Forward to Chatur with context
  await forwardToChatur(result.escalationContext);
}
```

## 📊 Data Flow

```
User Query
    ↓
Query Router (LLM)
    ↓
┌─────────────────┬──────────────────┬─────────────────┐
│   Pure Data     │   Pure Coaching  │   Mixed Query   │
│  (Mill only)    │  (Chatur only)   │  (Mill+Chatur)  │
└────────┬────────┴────────┬─────────┴────────┬────────┘
         ↓                 ↓                  ↓
    Read CSV         Redirect to      Read CSV THEN
    Format Data       Chatur          Offer Chatur
    Return                            With Context
```

## 🎯 Key Benefits

### 1. **No Unnecessary Handoffs**

- Mill doesn't forward simple "show me" queries to Dev
- Direct CSV reading is faster and simpler

### 2. **Smart Agent Selection**

- LLM understands WHAT vs WHY questions
- Routes to the right agent immediately

### 3. **Context Preservation**

- When escalating to Chatur, includes transaction data
- Chatur gets full context for better coaching

### 4. **User-Friendly Flow**

- Mixed queries get best of both worlds
- Data shown first (immediate value)
- Coaching offered second (deeper insights)

## 🔧 Architecture

### Independence

- **Mill reads transactions.csv directly** - no Dev dependency
- **Mill only escalates when coaching needed** - autonomous for data queries
- **Chatur gets rich context** - transaction summaries included

### Modularity

```
mill/
  ├── transaction-reader.ts       # CSV parsing & filtering
  ├── query-router.ts             # LLM-powered routing decision
  ├── transaction-query-handler.ts # Intent parsing & data fetching
  └── integrated-query-handler.ts  # Orchestrates everything
```

### CSV Format Support

Reads Dev's optimized 13-column format:

```
owner_phone,transaction_id,datetime,date,time,amount,currency,type,
target_party,description,category,is_financial,medium
```

## 📈 Future Enhancements

1. **Caching** - Cache recent queries to reduce CSV reads
2. **Aggregation** - Pre-compute monthly summaries
3. **Voice Interface** - Natural language understanding ready
4. **Multi-CSV** - Support reading from multiple files
5. **Real-time Sync** - Watch for CSV changes and invalidate cache

## ✨ Summary

Mill is now **truly intelligent**:

- ✅ Reads transaction data directly (fast, independent)
- ✅ Understands query intent with LLM (smart routing)
- ✅ Knows when to handle vs escalate (proper boundaries)
- ✅ Provides data + coaching path (user-friendly)
- ✅ Works without Dev agent for queries (autonomous)

**The user gets exactly what they need, when they need it!**
