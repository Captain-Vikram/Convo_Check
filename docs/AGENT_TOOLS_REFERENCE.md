# Quick Reference: Agent Tools & Interactions

## Agent Capabilities Matrix

| Agent                        | Tools                                                                | Database Access                                                                     | Can Trigger        | Triggered By                | Conversational |
| ---------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------ | --------------------------- | -------------- |
| **Mill (Chatbot)**           | log_cash_transaction<br>query_spending_summary<br>get_factual_answer | Read: all CSVs<br>Write: none                                                       | Dev, Param, Chatur | User input                  | ✅ Yes         |
| **Dev (Transaction)**        | saveToDatabase<br>sendToAnalyst                                      | Read: transactions.csv<br>Write: transactions.csv, analyst-metadata.csv             | None (data layer)  | Mill, SMS ingestion         | ❌ No          |
| **Param (Analyst)**          | metrics_snapshot<br>habit_recommendation                             | Read: transactions.csv, analyst-metadata.csv<br>Write: habits.csv, habit-snapshots/ | Chatur (auto)      | Mill, Dev (via metadata)    | ❌ No          |
| **Chatur (Coach)**           | Financial Calculations<br>(auto-triggered)                           | Read: habits.csv, habit-snapshots/, Param vector DB<br>Write: coach-briefings.json  | Mill (escalation)  | Param (auto), Mill (manual) | ✅ Yes         |
| **ConversationRouter (NEW)** | Routes between Mill & Chatur<br>Manages agent handoffs               | Read: conversation context                                                          | Mill, Chatur       | User input                  | ✅ Yes         |

## Data Flow Diagram

```
USER INPUT
    ↓
┌─────────────────────────────────────────────────────────────┐
│ MILL (Orchestrator)                                         │
│ Tools: log_cash_transaction, query_spending_summary         │
└────┬────────────────────────────────────────┬───────────────┘
     │                                        │
     │ calls runDevPipeline                   │ calls runAnalyst
     ↓                                        ↓
┌─────────────────────────┐         ┌──────────────────────────┐
│ DEV (Data Gateway)      │         │ PARAM (Analyst)          │
│ Tools: saveToDatabase,  │         │ Tools: metrics_snapshot, │
│        sendToAnalyst    │────────→│        habit_recommendation│
└────┬────────────────────┘         └────┬─────────────────────┘
     │                                   │
     │ writes to                         │ auto-triggers
     ↓                                   ↓
transactions.csv              ┌──────────────────────────┐
analyst-metadata.csv          │ CHATUR (Coach)           │
                              │ Tools: none              │
                              └────┬─────────────────────┘
                                   │
                                   │ writes to
                                   ↓
                              coach-briefings.json
```

## Inter-Agent Communication Patterns

### 1. Transaction Logging Flow

```
User: "Spent 500 on groceries"
  → Mill.log_cash_transaction(amount=500, desc="groceries")
    → Dev.saveToDatabase(normalized_tx)
      → transactions.csv (append)
    → Dev.sendToAnalyst(metadata)
      → analyst-metadata.csv (append)
```

### 2. Query Summary Flow

```
User: "Show my spending"
  → Mill.query_spending_summary()
    → runAnalyst()
      → Param reads transactions.csv
      → Param generates insights
      → Param writes habits.csv
      → Param calls runCoach()
        → Chatur reads habits.csv
        → Chatur generates guidance
        → Chatur writes coach-briefings.json
    → Mill aggregates all data
    → Returns to user
```

### 3. SMS Ingestion Flow

```
SMS Export File
  → Dev SMS Agent reads SMS
  → Dev.extractTransactionFromSms(sms)
  → Dev.categorizeTransaction(details)
  → Dev.runDevPipeline(payload)
    → Dev.saveToDatabase(normalized_tx)
    → Dev.sendToAnalyst(metadata)
```

### 4. Duplicate Detection Flow

```
Transaction arrives
  → Dev.saveToDatabase(tx)
    → Dev.findDuplicate(tx)
      → if < 2 min: auto-suppress (SuppressedDuplicateError)
      → if > 2 min: create pending (DuplicateTransactionError)
        → Mill receives duplicate event
        → Mill asks user: "log duplicate {id}" or "ignore duplicate {id}"
        → User responds
        → Dev.resolveDuplicate(pendingId, action)
          → if "record": save + send to analyst
          → if "ignore": discard pending
```

### 5. Real-time Monitoring Flow

```
Dev.startCsvMonitor()
  → watches transactions.csv for changes
  → detects new rows (not in knownTransactionIds)
  → triggers onNewRecords(newTxs)
    → Mill generates notification
    → User sees: "Dev detected new transaction: ..."
```

## Conversational Capabilities (NEW)

### Mill's Conversational Flow

```
User: "I spent 500"
Mill: "Got it! What was the 500 rupees for? 💸"
User: "Groceries"
Mill: "Perfect! Logging INR 500 for groceries. ✨ [Transaction saved]"
```

**Mill understands**:

- Transaction amounts and purchases → logs them
- Data queries ("show me", "how much") → queries database
- Advice requests ("should I", "help me") → escalates to Chatur

### Chatur's Conversational Flow

```
User: "How can I save more money?"
Chatur: "Great goal! 💡 What's your biggest expense category?"
User: "Food, around 5000 per week"
Chatur: "That's significant! Is it eating out or groceries?"
User: "Mostly eating out"
Chatur: "Let's start with cooking 2-3 meals/week. [Final guidance]"
```

**Chatur understands**:

- Advice/goal-setting requests → multi-turn coaching
- Transaction mentions ("I spent") → escalates to Mill
- Financial challenges → asks clarifying questions

### Agent Handoff Flow

```
User starts with Chatur: "I want to budget better"
Chatur: "Excellent! What's your monthly income?"
User: "Actually, I just got paid 25000 today"
Chatur: "Let me connect you with Mill to log that income first. 📝"
→ Switches to Mill
Mill: "Great! INR 25000 income logged. Now back to Chatur for budgeting advice."
→ Switches back to Chatur
Chatur: "Perfect! With INR 25000, let's create a budget..."
```

## NEW: Enhanced Agentic Interactions

### 6. Smart Routing (New)

```
User: "How much did I spend on food?"
  → Orchestrator.route(userInput)
    → LLM analyzes intent
    → Returns: { primaryAgent: "param", workflow: [...] }
  → Mill executes routing decision
    → Sends to Param via MessageBus
```

### 7. Inter-Agent Dialogue (New)

```
Dev detects anomaly
  → MessageBus.send({ from: "dev", to: "param", type: "question" })
    → "Is INR 5000 food spending a celebration?"
  → Param analyzes patterns
    → MessageBus.send({ from: "param", to: "chatur", type: "request" })
  → Chatur generates advice
    → MessageBus.send({ from: "chatur", to: "mill", type: "notification" })
  → Mill notifies user
```

### 8. Conversational Coach (New)

```
User: "Give me advice"
  → ConversationalCoach.startConversation({ insights })
    → Coach: "What's your main financial goal?"
  → User: "Save more money"
    → ConversationalCoach.continueConversation(sessionId, response)
      → Coach: "What categories do you spend most on?"
  → User: "Food and entertainment"
    → ConversationalCoach.continueConversation(sessionId, response)
      → Coach: [personalized guidance based on conversation]
      → completed: true, guidance: { headline, counsel, evidence }
```

## Shared Data Files

| File                    | Format | Written By | Read By             | Purpose                               |
| ----------------------- | ------ | ---------- | ------------------- | ------------------------------------- |
| transactions.csv        | CSV    | Dev        | Param, Mill, Chatur | Master transaction log                |
| analyst-metadata.csv    | CSV    | Dev        | Param               | Lightweight analytics feed            |
| habits.csv              | CSV    | Param      | Chatur, Mill        | Current habit insights (5-7 rows)     |
| coach-briefings.json    | JSON   | Chatur     | Mill                | Financial guidance history            |
| habit-snapshots/\*.json | JSON   | Chatur     | Chatur              | Versioned insight snapshots (by hash) |
| sms-ingest-log.csv      | CSV    | Dev SMS    | Dev SMS             | SMS processing audit trail            |
| agent-messages.log      | JSONL  | MessageBus | All                 | Inter-agent communication log (NEW)   |

## CSV Schemas

### transactions.csv

```csv
transaction_id,recorded_at,event_date,event_time,direction,amount,currency,category,flavor,description,raw_text,tags,structured_summary,heuristics,raw_category_suggestion,parsed_temporal_phrase,meta_source,meta_medium,meta_target_party
```

### analyst-metadata.csv

```csv
transaction_id,recorded_at,amount,currency,direction,category,flavor,tags,description,event_date,event_time
```

### habits.csv

```csv
habit_label,evidence,counsel,full_text
"Regular Food Spending","INR 500 avg per transaction","Consider meal planning","- Habit Label: Regular Food Spending; Evidence: INR 500 avg per transaction; Counsel: Consider meal planning."
```

### coach-briefings.json

```json
[
  {
    "id": "uuid",
    "createdAt": "2025-10-18T12:00:00Z",
    "headline": "Track Daily Expenses",
    "counsel": "Set a daily budget for food and track spending",
    "evidence": "INR 3000 in 7 days on food",
    "insightHash": "abc123",
    "trigger": "analyst"
  }
]
```

## Tool Execution Examples

### Mill's log_cash_transaction

```typescript
// Tool Definition
{
  name: "log_cash_transaction",
  parameters: {
    amount: number,
    description: string,
    category_suggestion: string,
    direction: "expense" | "income",
    raw_text: string
  }
}

// Execution
await executor({
  amount: 500,
  description: "groceries at local store",
  category_suggestion: "Food & Groceries",
  direction: "expense",
  raw_text: "spent 500 on groceries"
});

// Result: Transaction logged to transactions.csv via Dev
```

### Mill's query_spending_summary

```typescript
// Tool Definition
{
  name: "query_spending_summary",
  parameters: {} // No parameters
}

// Execution
const summary = await executor();

// Returns:
{
  totalExpense: 15000,
  totalIncome: 25000,
  netBalance: 10000,
  transactionCount: 45,
  recentTransactions: [
    { id: "tx_1", direction: "expense", amount: 500, ... },
    // ... last 10 transactions
  ],
  topCategories: [
    { category: "Food & Dining", totalSpent: 5000, count: 20 },
    // ... top 5 categories
  ],
  paramInsights: [
    "- Habit Label: Frequent Food...",
    // ... Param's latest insights
  ],
  coachAdvice: "Focus on reducing food expenses — Set a daily budget of INR 200"
}
```

### Param's habit_recommendation

```typescript
// Tool Definition (internal, not exposed to Mill)
{
  name: "habit_recommendation",
  parameters: {
    pattern: string,      // e.g., "Frequent Food Spending"
    evidence: string,     // e.g., "INR 500 avg per transaction"
    action: string        // e.g., "Consider meal planning"
  }
}

// Used internally by Param to structure insights
```

## Error Handling (NEW)

### Circuit Breaker States

```
CLOSED (normal) → failures → OPEN (reject) → timeout → HALF_OPEN (test) → success → CLOSED
                                              ↓
                                         fallback executed
```

### Retry Logic

```typescript
// Exponential backoff: 1s, 2s, 4s
await withRetry(async () => callGeminiAPI(), {
  maxAttempts: 3,
  backoffMultiplier: 2,
});
```

## NEW: Financial Calculation Tools (Chatur)

### Overview

Chatur now includes **mathematically accurate financial calculators** that automatically trigger for calculation-based queries. These tools provide exact numbers that Chatur then translates into natural, actionable advice.

### Calculation Types

#### 1. Savings Goal Calculator

**Triggers on**: "save X per month", "reach X in Y months", "how much daily to save"

**Calculates**:

- Daily, weekly, monthly savings requirements
- Affordability check (% of income)
- Recommended adjustments if unachievable

**Example Query**: _"How much should I save daily to reach ₹10,000 in 6 months?"_

**Calculation Output**:

```
Target: ₹10,000
Current Savings: ₹2,340
Need to Save: ₹7,660

Required Savings:
• Daily: ₹43 (one auto ride or two chai breaks)
• Weekly: ₹295 (one dinner out)
• Monthly: ₹1,277 (6% of income)

✅ Achievable: Only 6% of monthly income
```

**Chatur's Natural Response**:

> "Great goal! To reach ₹10,000 in 6 months from your current ₹2,340 savings, you'd need to save about ₹43 per day. That's roughly the cost of one auto ride or two cups of chai. Looking at your spending, you spend ₹1,800/month on dining out. If we redirect 70% of that, you'd hit your goal while still enjoying occasional treats..."

---

#### 2. Daily Budget Calculator

**Triggers on**: "how much can I spend daily", "daily budget", "spending limit per day"

**Calculates**:

- Daily and weekly discretionary spending limits
- Budget breakdown (income - fixed - savings)
- Affordability warnings if too tight

**Example Query**: _"How much can I spend daily if I want to save ₹4,000 per month?"_

**Calculation Output**:

```
Monthly Income: ₹20,000
Fixed Expenses: ₹10,000
Savings Goal: ₹4,000
Discretionary: ₹6,000

Your Spending Budget:
• Daily: ₹200
• Weekly: ₹1,385
```

**Chatur's Natural Response**:

> "Smart question! With ₹20k income, ₹10k fixed expenses, and ₹4k savings goal, you have ₹6,000 for everything else. That's ₹200 per day—about 2 meals out OR 1 meal + groceries + one treat. This is tight but doable. However, gig work has income swings, right? Maybe flexible approach: ₹200/day in good weeks, ₹250 in lean weeks..."

---

#### 3. Budget Allocation (50/30/20 Rule)

**Triggers on**: "how should I allocate", "budget breakdown", "divide my income"

**Calculates**:

- 50% Needs (essentials)
- 30% Wants (lifestyle)
- 20% Savings (future)
- Emergency fund targets (3-6 months)

**Example Query**: _"How should I divide my ₹25,000 monthly income?"_

**Calculation Output**:

```
Recommended Allocation:
• Needs (50%): ₹12,500 (rent, food, utilities)
• Wants (30%): ₹7,500 (entertainment, dining)
• Savings (20%): ₹5,000 (emergency, goals)

Emergency Fund Target:
• Minimum (3 months): ₹75,000
• Ideal (6 months): ₹1,50,000
```

**Chatur's Natural Response**:

> "Let me show you the 50/30/20 rule adapted for your ₹25,000 income. Ideally: ₹12,500 needs, ₹7,500 wants, ₹5,000 savings. But I see your income varies (₹15-25k). So let's be flexible: High income months (₹25k+) → save 20%. Normal months (₹20k) → save 10-15%. Looking at your data, you're spending 45% on food—that's our biggest opportunity..."

---

#### 4. Affordability Check

**Triggers on**: "can I afford", "should I buy", purchase decision queries

**Calculates**:

- % of monthly income
- % of current savings
- Emergency fund impact
- Months to save if needed
- Recommendation (buy_now / save_first / reconsider)

**Example Query**: _"Can I afford to buy a ₹15,000 phone?"_

**Calculation Output**:

```
Analysis:
• 75% of monthly income (₹20,000)
• 187% of current savings (₹8,000)
• ⚠️ Impact on emergency fund: YES

Recommendation: SAVE_FIRST
Reason: Would dip emergency fund. Save for 3 months (₹2,334/month)
```

**Chatur's Natural Response**:

> "Let's look at this carefully. A ₹15,000 phone is 75% of your monthly income—that's significant. If you buy now, you'd have only ₹-7,000 left, dipping below your emergency buffer. For gig workers with irregular income, that's risky. Better path: Save ₹2,334/month for 3 months. That's ₹78 daily. I notice you spend ₹200/day on average, so cutting back 40% would work..."

---

### Technical Implementation

**Module**: `src/tools/financial-calculator.ts`

**Key Functions**:

```typescript
// Exported functions
calculateSavingsGoal(target, current, months, income): SavingsGoalCalculation
calculateDailyBudget(income, fixed, savings): DailyBudgetResult
calculateBudgetAllocation(income): BudgetAllocation
checkAffordability(cost, income, savings, expenses): AffordabilityCheck
calculateCompoundInterest(principal, rate, years, monthly): CompoundInterestResult
calculateDebtPayoff(principal, rate, payment): DebtPayoffPlan

// Utility functions
formatCurrency(amount): string  // "₹10,000"
formatPercentage(value): string // "6.5%"
```

**Integration with Chatur**:

1. **Detection**: `needsFinancialCalculation(query)` checks if query needs math
2. **Extraction**: `extractCalculationParams(query, context)` parses amounts, timeframes
3. **Calculation**: `performCalculation(type, params)` runs exact math
4. **Natural Language**: Chatur receives calculations and explains in conversational tone

**Example Flow**:

```
User: "Save ₹200 per month, how much daily?"
  ↓
needsFinancialCalculation() → TRUE
  ↓
extractCalculationParams() → { type: "savings_goal", params: {target: 200, ...} }
  ↓
performCalculation() → "Daily: ₹7, Weekly: ₹46, Monthly: ₹200"
  ↓
Chatur receives calculation in prompt context
  ↓
Chatur: "₹200/month—I LOVE this! You're starting small and realistic.
         The math: ₹7 daily (literally one chai + biscuit). Looking at
         your spending, you spend ₹200-300 daily. Saving ₹7 means ₹193
         instead of ₹200. Three easy ways to find ₹7 daily: [strategies]..."
```

### Calculation Accuracy

✅ **Mathematically Precise**:

- All calculations use standard formulas
- Rounding only for display (₹43.21 → ₹43)
- Handles edge cases (negative savings, infinite debt payoff)

✅ **Context-Aware**:

- Uses actual user data (income, expenses, savings)
- Adjusts for irregular gig income patterns
- Considers emergency fund requirements

✅ **Validated Output**:

- Test suite covers all calculation types
- Edge cases tested (zero income, negative balance)
- Comparison against financial calculators

### Test Calculations

Run comprehensive tests:

```bash
node test-calculations.js
```

**Test Scenarios**:

1. Savings goal: ₹10,000 in 6 months → ₹43/day
2. Daily budget: Save ₹4,000/month → ₹200/day spending
3. Budget allocation: ₹25,000 income → 50/30/20 breakdown
4. Affordability: ₹15,000 phone → Save first (3 months)
5. Small goal: ₹200/month → ₹7/day (1.3% of income)

---

## Quick Commands

### Test Financial Calculations

```bash
node test-calculations.js
```

### Start Chatbot with All Agents

```bash
npm run dev
# or
node --import tsx src/index.ts
```

### Ingest SMS Export

```bash
node --import tsx src/runtime/dev-sms-agent.ts sms_export.json
```

### Run Analyst Manually

```bash
node --import tsx -e "import('./src/runtime/analyst-agent.js').then(m => m.runAnalyst())"
```

### Run Coach Manually

```bash
node --import tsx -e "import('./src/runtime/coach-agent.js').then(m => m.runCoach())"
```

### Check Circuit Breaker Status (NEW)

```bash
node --import tsx -e "import('./src/runtime/error-handling.js').then(m => console.log(m.getCircuitBreaker('analyst-llm').getState()))"
```

### View Agent Messages (NEW)

```bash
tail -f data/agent-messages.log | jq
```

## Integration Checklist

For integrating new agentic features:

- [ ] Replace `appendFile` with `getCsvWriter().append()` in dev-agent.ts
- [ ] Wrap all LLM calls with `getCircuitBreaker().execute()`
- [ ] Initialize `getMessageBus()` in chatbot-session.ts
- [ ] Register message handlers for each agent
- [ ] Add `AgentOrchestrator` to user input handling
- [ ] Create conversational coach sessions for advice requests
- [ ] Test inter-agent messaging with sample scenarios
- [ ] Add monitoring for circuit breaker trips
- [ ] Update tests for new error handling paths

## Performance Targets

| Operation                | Current | Target (Enhanced)           |
| ------------------------ | ------- | --------------------------- |
| Transaction log          | 50ms    | 55ms (+10%)                 |
| Query summary            | 2s      | 2.1s (+5%)                  |
| SMS ingestion (100 msgs) | 30s     | 32s (+7%)                   |
| Analyst run              | 5s      | 5.5s (+10%)                 |
| Coach run                | 3s      | 3.2s (+7%)                  |
| **Uptime**               | **85%** | **99%+ (circuit breakers)** |

## Troubleshooting

### Issue: Circuit breaker stuck OPEN

```typescript
import { resetAllCircuitBreakers } from "./runtime/error-handling.js";
resetAllCircuitBreakers();
```

### Issue: Message bus memory leak

```typescript
const bus = getMessageBus();
bus.clearConversation(conversationId); // Clear old conversations
```

### Issue: Routing cache stale

```typescript
const orchestrator = new AgentOrchestrator();
orchestrator.clearCache(); // Clear routing cache
```

### Issue: CSV write collision

```typescript
// Already handled by atomic-csv.ts with file-level locking
// If issues persist, check disk I/O capacity
```

---

**For full details**, see:

- `AGENTIC_ENHANCEMENT_SUMMARY.md` - Complete system overview
- `AGENTIC_INTEGRATION_GUIDE.md` - Step-by-step integration
- Individual component files in `src/runtime/`
