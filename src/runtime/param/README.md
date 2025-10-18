# Param Agent - Habit Tracking System

**Intelligent spending habit analysis triggered automatically by transaction logging.**

## 🎯 Overview

Param agent now includes an advanced habit tracking system that:

- **Automatically analyzes** every new transaction with LLM
- **Learns patterns** by examining last 5 transactions + previous habits
- **Creates habit snapshots** for Chatur's coaching insights
- **Builds progressive understanding** of spending behavior

## 📊 How It Works

```
New Transaction Logged (Dev)
    ↓
Param Triggered Automatically
    ↓
LLM Analysis (considers context)
    ↓
Habit Entry Created (habits.csv)
    ↓
Snapshot Saved (habit-snapshots/*.json)
    ↓
Available for Chatur Coaching
```

## 🗂️ Data Structure

### Habits CSV (`data/habits.csv`)

**13 columns tracking spending behavior:**

| Column                | Description                               |
| --------------------- | ----------------------------------------- |
| `habit_id`            | Unique SHA-1 hash identifier              |
| `recorded_at`         | ISO timestamp when habit was recorded     |
| `transaction_id`      | Links to transaction in transactions.csv  |
| `transaction_date`    | Date of the analyzed transaction          |
| `transaction_amount`  | Amount spent/received                     |
| `transaction_type`    | debit, credit, income, expense            |
| `target_party`        | Merchant/recipient                        |
| `category`            | Transaction category                      |
| `spending_pattern`    | LLM-identified pattern                    |
| `frequency`           | daily, weekly, monthly, irregular         |
| `average_amount`      | Running average for this pattern          |
| `total_spent`         | Cumulative amount                         |
| `transaction_count`   | Number of similar transactions            |
| `habit_type`          | recurring, one-time, frequent-small, etc. |
| `risk_level`          | low, moderate, high                       |
| `suggestions`         | LLM-generated advice                      |
| `recent_transactions` | Last 5 transaction IDs (context)          |
| `previous_habit_id`   | Links to previous habit for history       |

### Habit Snapshots (`data/habit-snapshots/*.json`)

**Rich behavioral data for Chatur's coaching with full analysis context:**

```json
{
  "snapshotId": "abc123...",
  "createdAt": "2025-10-18T10:30:00Z",
  "transactionId": "528488568914",
  "ownerPhone": "+919619183585",

  "contextTransactions": [
    {
      "transactionId": "528229066015",
      "date": "2025-10-09",
      "amount": 1.0,
      "type": "debit",
      "targetParty": "9324612161@kotak811",
      "category": "Financial - High Confidence"
    }
  ],
  "contextHabits": [
    {
      "habitId": "def456...",
      "transactionDate": "2025-10-09",
      "habitType": "recurring",
      "spendingPattern": "Regular small payments to same merchant",
      "frequency": "daily",
      "suggestions": "Track small frequent expenses"
    }
  ],

  "totalDebits": 1000.0,
  "totalCredits": 500.0,
  "netBalance": -500.0,
  "transactionCount": 13,

  "topCategories": [{ "category": "Food & Dining", "amount": 300, "count": 5 }],
  "frequentMerchants": [
    { "merchant": "9324612161@kotak811", "amount": 100, "count": 3 }
  ],

  "averageTransactionSize": 76.9,
  "largestTransaction": 666.0,
  "mostActiveTime": "evening",

  "isOverspending": false,
  "hasRecurringPayments": true,
  "showsImpulseBuying": false,
  "needsBudgetAlert": false,

  "behaviorSummary": "...",
  "recommendations": ["..."]
}
```

**Context Fields (NEW):**

- **`contextTransactions`**: The last 5 transactions Param analyzed to understand patterns. Chatur can reference these to explain why certain habits were identified.

- **`contextHabits`**: The last 3 habit entries that provided behavioral continuity. Shows the progression of spending patterns over time.

## 🚀 Usage

### 1. Initialize Habits from Existing Transactions

```bash
# Analyzes all transactions and creates initial habit entries
node scripts/init-habits.js
```

**Output:**

- `data/habits.csv` - Complete habit log
- `data/habit-snapshots/*.json` - Vector snapshots for each transaction

### 2. Automatic Integration with Dev Agent

```typescript
import { enableDevParamIntegration } from "./runtime/shared";
import { createDevAgentEnvironment } from "./runtime/dev";

const devEnv = await createDevAgentEnvironment();

// Enable automatic habit tracking
const stopIntegration = await enableDevParamIntegration({
  devEnvironment: devEnv,
  habitTrackerOptions: {
    baseDir: "./data",
    lookbackCount: 5, // Analyze last 5 transactions for context
    model: "gemini-2.0-flash-exp",
  },
  onHabitAnalyzed: async ({ transaction, habitId, snapshotId }) => {
    console.log(`Habit tracked: ${habitId}`);
    // Optionally notify Chatur agent
  },
});

// New transactions will automatically trigger habit analysis
```

### 3. Manual Habit Analysis

```typescript
import { analyzeTransactionHabit } from "./runtime/param";

const transaction = {
  ownerPhone: "+919619183585",
  transactionId: "528488568914",
  datetime: "2025-10-11T20:48:22",
  date: "2025-10-11",
  time: "20:48:22",
  amount: 1.0,
  currency: "Rs.",
  type: "debit",
  targetParty: "9324612161@kotak811",
  description: "Ref:528488568914, to 9324612161@kotak811, AvlBal:Rs288.41",
  category: "Financial - High Confidence",
  isFinancial: true,
  medium: "",
};

const { habitEntry, snapshot } = await analyzeTransactionHabit(transaction);

console.log(`Pattern: ${habitEntry.spendingPattern}`);
console.log(`Habit Type: ${habitEntry.habitType}`);
console.log(`Risk: ${habitEntry.riskLevel}`);
console.log(`Suggestion: ${habitEntry.suggestions}`);
```

## 🧠 LLM Analysis

### Context-Aware Learning

The system provides rich context to the LLM:

1. **Current Transaction:** Full details of the new transaction
2. **Recent History:** Last 5 transactions for pattern detection
3. **Previous Habits:** Last 3 habit entries for behavioral continuity

### Analysis Prompt

```
Analyze this financial transaction and identify spending habits for a gig worker.

**Current Transaction:**
- Date: 2025-10-11 20:48:22
- Type: debit
- Amount: 1.0 Rs.
- Target: 9324612161@kotak811
- Category: Financial - High Confidence

**Recent Transactions (Last 5):**
1. 2025-10-09 - debit 1.0 Rs. to 9324612161@kotak811
2. 2025-10-07 - debit 250.0 Rs. to nafisahamd5678@okicici
...

**Previous Habit Insights:**
1. recurring - Regular small payments (daily)
2. one-time - One-time large expense (irregular)
...

Provide: spending_pattern, frequency, habit_type, risk_level, suggestions, behavior_summary
```

### Fallback Rule-Based Analysis

If LLM fails, the system uses intelligent fallback rules:

- Detects recurring patterns by merchant matching
- Classifies by transaction size (small/large)
- Estimates risk based on amount thresholds
- Provides generic but useful suggestions

## 📈 Habit Types Detected

| Type               | Description                       | Example               |
| ------------------ | --------------------------------- | --------------------- |
| `recurring`        | Regular payments to same merchant | Monthly subscriptions |
| `one-time`         | Single large expense              | Emergency purchase    |
| `irregular`        | Unpredictable pattern             | Occasional dining out |
| `frequent-small`   | Many small transactions           | Daily coffee          |
| `occasional-large` | Rare big expenses                 | Annual insurance      |

## 🎯 Risk Levels

- **Low:** Small amounts, infrequent
- **Moderate:** Regular spending, manageable amounts
- **High:** Large amounts, potential overspending

## 🔄 Progressive Learning

Each habit entry links to previous ones:

```
Habit 1 (First transaction)
  ↓ (previous_habit_id)
Habit 2 (Second transaction, knows about Habit 1)
  ↓ (previous_habit_id)
Habit 3 (Third transaction, knows about Habit 2)
  ...
```

This creates a **learning chain** where:

- Patterns become clearer over time
- Behavioral shifts are detected
- Insights become more accurate

## 💡 Integration with Chatur (Coach)

Chatur can read habit snapshots to provide:

- **Personalized coaching:** Based on actual spending patterns
- **Trend alerts:** "You're spending 20% more on dining this month"
- **Budget recommendations:** "Based on your habits, set aside Rs. 500/week for groceries"
- **Goal tracking:** Monitor progress toward saving goals

### Example Chatur Query

```typescript
import { readFile } from "fs/promises";

// Read latest snapshot
const snapshot = JSON.parse(
  await readFile("data/habit-snapshots/abc123.json", "utf8")
);

if (snapshot.isOverspending) {
  console.log("🚨 Alert: Spending exceeds income by 50%");
  console.log(`Top expense: ${snapshot.topCategories[0].category}`);
  console.log(`Recommendation: ${snapshot.recommendations[0]}`);
}

// Use context for deeper insights
console.log("\n📊 Analysis Context:");
console.log(
  `Based on ${snapshot.contextTransactions.length} recent transactions`
);
console.log(`Habit progression:`);
snapshot.contextHabits.forEach((habit, idx) => {
  console.log(`  ${idx + 1}. ${habit.habitType} - ${habit.spendingPattern}`);
});

// Provide contextual coaching
if (snapshot.hasRecurringPayments) {
  const recurring = snapshot.contextHabits.filter(
    (h) => h.habitType === "recurring"
  );
  console.log(`\n💡 You have ${recurring.length} recurring payment patterns.`);
  console.log(`Previous habit: "${recurring[0]?.spendingPattern}"`);
  console.log(
    `Suggestion: Consider consolidating subscriptions to save money.`
  );
}
```

### Using Context for Better Coaching

The **`contextTransactions`** and **`contextHabits`** fields allow Chatur to:

1. **Explain Pattern Detection**: "I noticed you've paid to 9324612161@kotak811 three times in the last week (see contextTransactions)"

2. **Show Behavioral Progression**: "Your spending pattern has shifted from 'irregular' to 'recurring' over the last 3 transactions"

3. **Provide Continuity**: "Last time I suggested tracking small expenses. I see you've continued with daily Rs. 1 payments"

4. **Historical Comparison**: "Compared to your habit on Oct 9, your frequency has increased from weekly to daily"

5. **Personalized Recommendations**: Based on actual transaction history, not generic advice

## 📊 Performance

- **LLM call per transaction:** ~1-2 seconds
- **Fallback analysis:** <100ms
- **CSV append:** Atomic, safe for concurrent access
- **Snapshot creation:** ~50ms

## 🔍 Debugging

Enable verbose logging:

```typescript
// Set before running
process.env.DEBUG = "habit-tracker:*";
```

Check habit quality:

```bash
# View last 5 habits
tail -n 5 data/habits.csv

# Count habits by type
cat data/habits.csv | cut -d',' -f14 | sort | uniq -c

# List snapshots
ls -lh data/habit-snapshots/
```

## 🛠️ Configuration

All configurable via options:

```typescript
{
  baseDir: './data',              // Data directory
  transactionsFile: 'transactions.csv',
  habitsFile: 'habits.csv',
  snapshotsDir: 'habit-snapshots',
  lookbackCount: 5,               // Context window size
  model: 'gemini-2.0-flash-exp',  // LLM model
}
```

## 📝 Example Output

```
🔄 Initializing habits from existing transactions...
📊 Processing 13 transactions...
   Processed 5/13...
   Processed 10/13...
✅ Initialized 13 habit entries

💾 Saved to: data/habits.csv
📂 Snapshots: data/habit-snapshots/ (13 files)
⏱️  Completed in 15.3s
```

## 🎓 Best Practices

1. **Initialize Once:** Run `init-habits.js` after SMS import
2. **Enable Integration:** Let Dev automatically trigger Param
3. **Review Periodically:** Check habits.csv for pattern insights
4. **Use Snapshots:** Feed to Chatur for personalized coaching
5. **Monitor Performance:** Watch LLM call frequency/cost

## 🚧 Future Enhancements

- [ ] Aggregate analysis (weekly/monthly summaries)
- [ ] Anomaly detection (unusual spending alerts)
- [ ] Category-specific patterns
- [ ] Merchant reputation tracking
- [ ] Budget vs. actual comparison
- [ ] Savings goal progress tracking
