# Conversational Agents: Mill & Chatur

## Overview

Both **Mill** and **Chatur** now have full conversational capabilities, each with specialized understanding of their roles and when to collaborate.

## Agent Specializations

### 🤖 Mill (Transaction Specialist)

**Primary Role**: Transaction logging and financial data queries

**Understands**:

- When user wants to log transactions ("I spent 500 on groceries")
- When user wants to query data ("Show me my spending", "How much did I spend on food?")
- When user needs another agent ("I need advice" → escalates to Chatur)

**Tools Available**:

- `log_cash_transaction` - Log expenses/income
- `query_spending_summary` - Fetch financial data

**Conversation Style**:

- Quick, efficient, task-oriented
- Asks clarifying questions for incomplete transactions
- Friendly but focused on actions
- Uses emojis: 💸📊✨

### 💡 Chatur (Financial Coach)

**Primary Role**: Financial advice, goal setting, and habit coaching

**Understands**:

- When user seeks advice ("How should I budget?", "Help me save money")
- When user wants to set goals or improve habits
- When user needs transaction logging ("I spent..." → escalates to Mill)

**Tools Available**:

- None (receives insights from Param, focuses on coaching)

**Conversation Style**:

- Supportive, encouraging, patient
- Asks probing questions about goals and challenges
- Multi-turn dialogue (2-4 exchanges before final advice)
- Uses emojis: 💡✨💪

## How They Understand Context

### Mill's Understanding Logic

```typescript
// Mill analyzes user intent through LLM
{
  "intent": "logging|query|general|unclear",
  "action": "log_transaction|query_data|escalate_to_coach",
  "extractedInfo": {
    "transactionAmount": 500,
    "transactionDescription": "groceries",
    "transactionDirection": "expense"
  }
}
```

**Decision Tree**:

1. **Contains amount + purchase word** → intent: logging
2. **"How much" / "show me" / "total"** → intent: query
3. **"advice" / "should I" / "help me"** → action: escalate_to_coach
4. **Unclear** → asks clarifying question

### Chatur's Understanding Logic

```typescript
// Chatur analyzes coaching needs through LLM
{
  "intent": "advice_seeking",
  "extractedInfo": {
    "primaryGoal": "save|reduce_spending|increase_income",
    "problemArea": "food|entertainment|impulse",
    "timeline": "immediate|1month|3months"
  },
  "shouldEscalateToMill": false // true if user says "log this"
}
```

**Decision Tree**:

1. **User asks "what should I do"** → provide personalized advice
2. **User mentions specific goal** → ask follow-ups about constraints
3. **User says "I spent X"** → shouldEscalateToMill: true
4. **After 2-4 turns** → generate final guidance with action plan

## Conversation Router

The `ConversationRouter` intelligently routes messages to the right agent:

### Initial Routing

```typescript
// Keywords that trigger Mill
const millKeywords = [
  "spent",
  "paid",
  "bought",
  "earned",
  "log",
  "record",
  "show me",
  "how much",
  "total",
  "history",
  "transactions",
];

// Keywords that trigger Chatur
const chaturKeywords = [
  "advice",
  "tip",
  "help me",
  "should i",
  "goal",
  "save",
  "budget",
  "plan",
  "reduce",
  "improve",
  "habit",
];

// Special case: presence of numbers → Mill
if (/\d+/.test(userMessage)) {
  routeTo("mill");
}
```

### Agent Handoff (Escalation)

**Mill → Chatur**:

```
User: "I spent 500 on food"
Mill: "Logged! 💸 By the way, I noticed you're spending a lot on food."
User: "Yeah, how can I reduce that?"
Mill: "Great question! Let me connect you with Chatur for advice. 💡"
→ Escalates to Chatur
Chatur: "Hey! I'm Chatur. Let's work on reducing food expenses. What's your biggest challenge?"
```

**Chatur → Mill**:

```
User: "I want to save more money"
Chatur: "Awesome goal! What's your main expense category?"
User: "Mostly food. Actually, I just spent 600 on groceries today."
Chatur: "Let me connect you with Mill to log that transaction first. 📝"
→ Escalates to Mill
Mill: "Got it! INR 600 on groceries. Let me log that for you. ✨"
```

## Usage Examples

### Example 1: Transaction Logging with Mill

```typescript
const router = getConversationRouter();

// Start conversation
const start = await router.startConversation(
  "user123",
  "I spent 500 on groceries",
  {
    onTransactionReady: async (payload) => {
      await runDevPipeline(payload, categorization, { tools });
    },
  }
);

// Mill detects intent: logging
console.log(start.agent); // "mill"
console.log(start.message); // "Got it! INR 500 on groceries. Let me log that! 💸"

// If incomplete, Mill asks follow-ups
const continue1 = await router.continueConversation(
  "user123",
  "spent some money"
);
// Mill: "How much did you spend?"

const continue2 = await router.continueConversation("user123", "300 rupees");
// Mill: "Great! What was it for?"

const final = await router.continueConversation(
  "user123",
  "lunch at restaurant"
);
// Mill: "Done! INR 300 for lunch at restaurant logged. ✨"
// final.completed === true
// final.result === { amount: 300, description: "lunch at restaurant", ... }
```

### Example 2: Financial Advice with Chatur

```typescript
const router = getConversationRouter();

// Start conversation
const start = await router.startConversation(
  "user456",
  "I need help budgeting my food expenses",
  {
    onInsightsAvailable: async () => {
      return await loadHabitRecords(); // Get Param's insights
    },
  }
);

// Chatur detects intent: advice_seeking
console.log(start.agent); // "chatur"
console.log(start.message);
// "Hey there! 💡 I'm Chatur, your financial coach.
//  What's your biggest financial challenge or goal right now?"

// Multi-turn conversation
const turn1 = await router.continueConversation(
  "user456",
  "I spend too much on food, around 5000 per week"
);
// Chatur: "I see you're spending INR 5000/week on food. That's quite a bit!
//          What's driving that spending - eating out, groceries, or both?"

const turn2 = await router.continueConversation(
  "user456",
  "Mostly eating out, I don't have time to cook"
);
// Chatur: "Time constraints make sense! What if we set a realistic goal -
//          like cooking 2-3 meals per week to start?"

const final = await router.continueConversation(
  "user456",
  "That sounds manageable, yes"
);
// Chatur: "Perfect! Here's your personalized plan: ..."
// final.completed === true
// final.result === { headline: "Start Small with Meal Prep", counsel: "...", ... }
```

### Example 3: Automatic Agent Switching

```typescript
const router = getConversationRouter();

// User starts with Chatur (advice)
const start = await router.startConversation(
  "user789",
  "How can I reduce my spending?",
  options
);

console.log(start.agent); // "chatur"

// During conversation, user mentions a transaction
const turn1 = await router.continueConversation(
  "user789",
  "That makes sense. I just spent 1200 on electronics today."
);

// Chatur detects transaction mention and escalates
console.log(turn1.switched); // true
console.log(turn1.newAgent); // "mill"
console.log(turn1.message);
// "Let me connect you with Mill who can help you log that transaction. 📝"

// Now talking to Mill
const turn2 = await router.continueConversation(
  "user789",
  "Yes, log 1200 for laptop"
);

console.log(turn2.agent); // "mill"
// Mill logs transaction...
```

## Integration with Chatbot Session

Update `chatbot-session.ts` to use the conversation router:

```typescript
import { getConversationRouter } from "./conversation-router.js";

const conversationRouter = getConversationRouter();

async function handleUserInput(
  userInput: string,
  userId: string
): Promise<void> {
  const context = conversationRouter.getContext(userId);

  if (!context) {
    // New conversation - router determines agent
    const result = await conversationRouter.startConversation(
      userId,
      userInput,
      {
        onTransactionReady: async (payload) => {
          const categorization = categorizeTransaction(
            payload.description,
            payload.amount
          );
          await runDevPipeline(payload, categorization, { tools: devTools });
        },
        onQueryReady: async () => {
          await runAnalyst();
          const transactions = await loadTransactions();
          const insights = await loadHabitRecords();
          const coachBriefing = await loadLatestCoachBriefing();
          return {
            /* summary data */
          };
        },
        onInsightsAvailable: async () => {
          return await loadHabitRecords();
        },
      }
    );

    output.write(`${result.agent}> ${result.message}\n`);
    return;
  }

  // Continue existing conversation
  const result = await conversationRouter.continueConversation(
    userId,
    userInput,
    {
      /* same options */
    }
  );

  // Handle agent switching
  if (result.switched) {
    output.write(`\n[Switched to ${result.newAgent}]\n`);
  }

  // Display response
  const agentName = result.agent === "mill" ? "Mill" : "Chatur";
  output.write(`${agentName}> ${result.message}\n`);

  // Handle completion
  if (result.completed) {
    if (result.agent === "mill" && result.result) {
      // Transaction logged or data retrieved
      console.log("[mill] Action completed:", result.result);
    } else if (result.agent === "chatur" && result.result) {
      // Final guidance provided
      const guidance = result.result as CoachGuidance;
      output.write(`\n✨ Final Guidance:\n`);
      output.write(`📌 ${guidance.headline}\n`);
      output.write(`💡 ${guidance.counsel}\n\n`);
    }
  }
}
```

## Benefits

### 1. Clear Role Separation

- Mill handles transactions and data
- Chatur handles advice and coaching
- No overlap or confusion

### 2. Intelligent Routing

- Users don't need to specify which agent
- System understands intent from natural language
- Automatic escalation when needed

### 3. Seamless Handoff

- Smooth transitions between agents
- Context preserved during switch
- User notified of agent changes

### 4. Natural Conversations

- Both agents ask clarifying questions
- Multi-turn dialogues feel human
- Appropriate tone for each role

### 5. Specialized Tools

- Each agent only has access to relevant tools
- Mill can execute database operations
- Chatur focuses purely on coaching

## Testing

### Test Mill Understanding

```typescript
// Test 1: Transaction logging
const tests = [
  "I spent 500 on groceries", // → Mill (amount present)
  "Bought lunch for 200", // → Mill (purchase + amount)
  "Earned 5000 from freelancing", // → Mill (income)
  "Show me my spending history", // → Mill (query keywords)
];

for (const test of tests) {
  const result = await router.startConversation("test", test, options);
  console.assert(result.agent === "mill", `Failed: ${test}`);
}
```

### Test Chatur Understanding

```typescript
// Test 2: Advice seeking
const tests = [
  "How can I save more money?", // → Chatur (advice keyword)
  "I need help budgeting", // → Chatur (help + budget)
  "What should I do about overspending?", // → Chatur (should I)
  "Give me tips to reduce expenses", // → Chatur (tips + reduce)
];

for (const test of tests) {
  const result = await router.startConversation("test", test, options);
  console.assert(result.agent === "chatur", `Failed: ${test}`);
}
```

### Test Escalation

```typescript
// Test 3: Mill → Chatur escalation
const router = getConversationRouter();
await router.startConversation("test", "I spent 500 on food", options);
const result = await router.continueConversation(
  "test",
  "Actually, how can I reduce my food spending?"
);
console.assert(result.switched === true);
console.assert(result.newAgent === "chatur");

// Test 4: Chatur → Mill escalation
await router.startConversation("test2", "Help me save money", options);
const result2 = await router.continueConversation(
  "test2",
  "I just spent 1000 on electronics"
);
console.assert(result2.switched === true);
console.assert(result2.newAgent === "mill");
```

## Configuration

### Adjusting Agent Personalities

Edit system prompts in:

- `conversational-mill.ts` → Mill's personality
- `conversational-coach.ts` → Chatur's personality

### Tuning Routing Logic

Edit keywords in `conversation-router.ts`:

```typescript
// Make Mill more aggressive in capturing transactions
const millKeywords = [
  // Add more transaction-related keywords
  "purchase",
  "deposit",
  "withdraw",
  "transfer",
];

// Make Chatur respond to more goal-setting phrases
const chaturKeywords = [
  // Add more coaching-related keywords
  "dream",
  "target",
  "aspiration",
  "resolution",
];
```

### Session Timeouts

```typescript
// Cleanup old sessions every hour
setInterval(() => {
  conversationRouter.cleanup(3600_000); // 1 hour
}, 3600_000);
```

## Summary

✅ **Mill** understands when to log transactions, query data, or escalate to Chatur  
✅ **Chatur** understands when to give advice, ask follow-ups, or escalate to Mill  
✅ **Router** intelligently determines which agent based on user intent  
✅ **Seamless handoff** between agents with context preservation  
✅ **Separate but coordinated** - each agent knows their specialization

Both agents now have true conversational intelligence while maintaining clear role boundaries!
