# Quick Start: Conversational Agents

## 5-Minute Integration Guide

### Step 1: Import the Router (1 min)

```typescript
// In your chatbot-session.ts or main entry point
import { getConversationRouter } from "./runtime/conversation-router.js";
import { loadHabitRecords } from "./runtime/analyst-agent.js";
import { runDevPipeline } from "./runtime/dev-agent.js";
import { categorizeTransaction } from "./runtime/categorize.js";
import { loadTransactions } from "./runtime/transactions-loader.js";

const conversationRouter = getConversationRouter();
```

### Step 2: Handle User Input (2 min)

```typescript
async function handleUserMessage(
  userId: string,
  message: string
): Promise<string> {
  const result = await conversationRouter.continueConversation(
    userId,
    message,
    {
      // When Mill completes transaction logging
      onTransactionReady: async (payload) => {
        const categorization = categorizeTransaction(
          payload.description,
          payload.amount
        );
        await runDevPipeline(payload, categorization, { tools: devTools });
      },

      // When Mill needs to query data
      onQueryReady: async () => {
        const transactions = await loadTransactions();
        const insights = await loadHabitRecords();
        return {
          totalExpense: transactions
            .filter((t) => t.direction === "expense")
            .reduce((sum, t) => sum + t.amount, 0),
          totalIncome: transactions
            .filter((t) => t.direction === "income")
            .reduce((sum, t) => sum + t.amount, 0),
          // ... rest of summary
        };
      },

      // When Chatur needs insights
      onInsightsAvailable: async () => {
        return await loadHabitRecords();
      },
    }
  );

  // Show which agent is responding
  const agentName =
    result.agent === "mill"
      ? "Mill"
      : result.agent === "chatur"
      ? "Chatur"
      : "System";

  // Notify on agent switch
  let response = "";
  if (result.switched) {
    response += `\n[Switched to ${result.newAgent}]\n\n`;
  }

  response += `${agentName}: ${result.message}`;

  return response;
}
```

### Step 3: Use in Your Chat Loop (2 min)

```typescript
// Example: Command-line interface
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function chatLoop() {
  const userId = "demo-user"; // In production, use actual user ID

  console.log("Chat with Mill & Chatur! Type your message:");

  rl.on("line", async (input) => {
    if (input.toLowerCase() === "exit") {
      conversationRouter.endConversation(userId);
      rl.close();
      return;
    }

    const response = await handleUserMessage(userId, input);
    console.log(response);
  });
}

chatLoop();
```

## Example Conversations

### Transaction Logging (Mill)

```
User: I spent 500 on groceries
Mill: Got it! Logging INR 500 for groceries. ✨
[Transaction saved to database]

User: Show me my spending
Mill: Let me fetch that for you! 📊
[Displays spending summary]
```

### Financial Advice (Chatur)

```
User: How can I save more money?
Chatur: Great goal! 💡 What's your biggest expense category?

User: Food, around 3000 per week
Chatur: That's significant! Is it eating out or groceries?

User: Mostly eating out
Chatur: Let's create a plan. Start by cooking 2-3 meals/week...
[Provides detailed guidance]
```

### Agent Switching

```
User: I want to budget better
Chatur: Excellent! What's your monthly income? 💡

User: I just got paid 25000 today
Chatur: Let me connect you with Mill to log that first. 📝

[Switched to mill]

Mill: Perfect! INR 25000 income logged. ✨
Mill: Back to Chatur for budgeting advice!

[Switched to chatur]

Chatur: With INR 25000, let's allocate...
```

## Common Patterns

### Pattern 1: Check Current Agent

```typescript
const context = conversationRouter.getContext(userId);
if (context) {
  console.log(`Currently talking to: ${context.activeAgent}`);
  console.log(`Conversation turns: ${context.conversationHistory.length}`);
}
```

### Pattern 2: Force Agent Switch

```typescript
// If you need to manually switch agents
conversationRouter.endConversation(userId);

// Start fresh with specific agent
const millResult = await conversationRouter.startConversation(
  userId,
  "I spent 500", // Mill will handle this
  options
);
```

### Pattern 3: Get Conversation Summary

```typescript
const summary = conversationRouter.getConversationSummary(userId);
console.log(summary);
// Output:
// Active Agent: mill
// Conversation History (3 turns):
// 1. [MILL]
//    You: I spent 500...
//    Mill: Got it! Logging...
```

### Pattern 4: Cleanup Old Sessions

```typescript
// Run periodically (e.g., every hour)
setInterval(() => {
  conversationRouter.cleanup(3600_000); // 1 hour timeout
}, 3600_000);
```

## Testing

### Quick Test Script

```typescript
// test-conversations.ts
import { getConversationRouter } from "./runtime/conversation-router.js";

async function runTests() {
  const router = getConversationRouter();

  console.log("Test 1: Transaction logging");
  const t1 = await router.startConversation(
    "test1",
    "I spent 500 on food",
    mockOptions
  );
  console.assert(t1.agent === "mill", "Should route to Mill");

  console.log("Test 2: Advice seeking");
  const t2 = await router.startConversation(
    "test2",
    "How can I save?",
    mockOptions
  );
  console.assert(t2.agent === "chatur", "Should route to Chatur");

  console.log("Test 3: Agent switching");
  await router.startConversation("test3", "Help me budget", mockOptions);
  const r3 = await router.continueConversation(
    "test3",
    "I earned 5000",
    mockOptions
  );
  console.assert(r3.switched === true, "Should switch to Mill");

  console.log("✅ All tests passed!");
}

runTests();
```

## Troubleshooting

### Issue: Agent not switching

```typescript
// Check if context exists
const context = conversationRouter.getContext(userId);
console.log("Active agent:", context?.activeAgent);
console.log("Session IDs:", context?.millSessionId, context?.chaturSessionId);

// Manually end and restart if stuck
conversationRouter.endConversation(userId);
```

### Issue: LLM timeout

```typescript
// Circuit breaker will automatically fallback to keyword-based routing
// Check logs for "[mill] Failed to generate response" messages

// To reset circuit breakers:
import { resetAllCircuitBreakers } from "./runtime/error-handling.js";
resetAllCircuitBreakers();
```

### Issue: Memory leak (sessions not cleaned up)

```typescript
// Manually trigger cleanup
conversationRouter.cleanup(1800_000); // 30 minutes

// Or more aggressively
conversationRouter.cleanup(600_000); // 10 minutes
```

## Configuration

### Adjust Agent Personalities

Edit `src/runtime/conversational-mill.ts`:

```typescript
// Make Mill more casual
const MILL_EMOJI = "😎"; // Instead of 💸

// Change tone
("Hey buddy! What's up?"); // Instead of "Hey! 👋"
```

Edit `src/runtime/conversational-coach.ts`:

```typescript
// Make Chatur more formal
"Greetings! I'm here to assist with your financial planning.";

// Or more casual
"Yo! Let's crush those money goals! 💪";
```

### Adjust Routing Keywords

Edit `src/runtime/conversation-router.ts`:

```typescript
// Add more Mill keywords
const millKeywords = [
  "spent",
  "paid",
  "bought",
  "purchase",
  "deposit",
  "withdraw", // Add these
];

// Add more Chatur keywords
const chaturKeywords = [
  "advice",
  "tip",
  "help",
  "mentor",
  "guide",
  "teach", // Add these
];
```

## Production Checklist

- [ ] Test transaction logging flow
- [ ] Test financial advice flow
- [ ] Test agent switching (Mill → Chatur)
- [ ] Test agent switching (Chatur → Mill)
- [ ] Add user ID tracking
- [ ] Set up session cleanup (hourly)
- [ ] Configure LLM timeouts
- [ ] Add error monitoring
- [ ] Test with concurrent users
- [ ] Add conversation analytics
- [ ] Set appropriate rate limits
- [ ] Document for end users

## Next Steps

1. **Basic**: Just use the router in your main chat loop
2. **Advanced**: Add custom agents beyond Mill & Chatur
3. **Expert**: Integrate with message bus for inter-agent communication

## Support

For issues or questions:

- Check `CONVERSATIONAL_AGENTS_GUIDE.md` for detailed documentation
- Check `CONVERSATIONAL_ARCHITECTURE_DIAGRAM.md` for system architecture
- Check `CONVERSATIONAL_IMPLEMENTATION_SUMMARY.md` for technical details

---

**You're ready to go!** 🚀

Start with Step 1-3 above and you'll have conversational agents running in 5 minutes.
