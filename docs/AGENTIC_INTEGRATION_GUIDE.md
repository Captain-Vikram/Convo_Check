# Agentic Enhancement Integration Guide

This guide shows how to integrate the new agentic features into your existing Convo Check system.

## New Components Overview

1. **AgentMessageBus** - Inter-agent communication without external APIs
2. **AgentOrchestrator** - LLM-based smart routing of user requests
3. **Error Handling** - Circuit breakers, retries, custom error types
4. **Atomic CSV** - Safe concurrent CSV operations
5. **Conversational Coach** - Multi-turn dialogue capability

## Integration Steps

### 1. Update chatbot-session.ts to use Message Bus

```typescript
import { getMessageBus, type AgentMessage } from "./agent-message-bus.js";
import { AgentOrchestrator } from "./agent-orchestrator.js";
import { getCircuitBreaker, withRetry } from "./error-handling.js";
import { getCsvWriter } from "./atomic-csv.js";
import { ConversationalCoach } from "./conversational-coach.js";

// Initialize components
const messageBus = getMessageBus();
const orchestrator = new AgentOrchestrator(true); // Enable caching
const csvWriter = getCsvWriter();
const conversationalCoach = new ConversationalCoach();

// Register Dev as message handler
messageBus.registerHandler("dev", "transaction-request", async (message) => {
  const payload = message.payload as LogCashTransactionPayload;
  // Process transaction...
  return {
    id: "response",
    from: "dev",
    to: message.from,
    type: "response",
    payload: { status: "logged", transactionId: "tx_123" },
    timestamp: new Date().toISOString(),
  };
});

// Register Param as message handler
messageBus.registerHandler("param", "analysis-request", async (message) => {
  await runAnalyst();
  return {
    id: "response",
    from: "param",
    to: message.from,
    type: "response",
    payload: { status: "complete", insights: [...] },
    timestamp: new Date().toISOString(),
  };
});
```

### 2. Add Smart Routing to User Input Handler

```typescript
async function handleUserInput(input: string): Promise<void> {
  // Use orchestrator to determine which agent should handle this
  const routing = await orchestrator.route(
    input,
    "User wants to manage finances"
  );

  console.log(
    `[orchestrator] Routing to ${routing.primaryAgent}: ${routing.reasoning}`
  );

  // Execute suggested workflow
  for (const step of routing.suggestedWorkflow) {
    console.log(`[workflow] ${step}`);
  }

  if (routing.primaryAgent === "mill") {
    // Handle as usual with Mill
    await handleWithMill(input);
  } else if (routing.primaryAgent === "param") {
    // Route directly to analyst
    await messageBus.send({
      from: "mill",
      to: "param",
      type: "request",
      payload: { action: "analyze", context: input },
    });
  } else if (routing.primaryAgent === "chatur") {
    // Start conversational session with coach
    const insights = await loadHabitRecords();
    const conversation = conversationalCoach.startConversation({
      insights,
      initialQuestion:
        "Let me help you with personalized advice. What's your main financial goal?",
    });
    output.write(`mill> ${conversation.currentQuestion}\n`);
  }
}
```

### 3. Replace CSV Operations with Atomic Writes

In `dev-agent.ts`, update the tools:

```typescript
import { getCsvWriter } from "./atomic-csv.js";

const csvWriter = getCsvWriter();

const tools: DevTools = {
  async saveToDatabase(transaction) {
    const duplicate = findDuplicate(transaction);
    // ... duplicate checking logic ...

    knownTransactionIds.add(transaction.id);
    updateDuplicateIndex(transaction);

    // Use atomic write instead of appendFile
    const csvRow = buildTransactionCsvRow(transaction);
    await csvWriter.append(transactionsFile, csvRow);
  },

  async sendToAnalyst(metadata) {
    const csvRow = buildAnalystCsvRow(metadata);
    await csvWriter.append(analystFile, csvRow);
  },
};
```

### 4. Add Circuit Breaker to LLM Calls

In `analyst-agent.ts` and `coach-agent.ts`:

```typescript
import { getCircuitBreaker, withRetry, LLMError } from "./error-handling.js";

const llmCircuitBreaker = getCircuitBreaker("analyst-llm");

async function callLanguageModel(prompt: string): Promise<string> {
  return llmCircuitBreaker.execute(
    async () => {
      return withRetry(
        async () => {
          const { apiKey, model } = getAgentConfig("agent3");
          const provider = createGoogleGenerativeAI({ apiKey });
          const languageModel = provider(model);

          const result = await generateText({
            model: languageModel,
            messages: [
              { role: "system", content: analystAgent.systemPrompt },
              { role: "user", content: prompt },
            ],
          });

          return result.text ?? "";
        },
        { maxAttempts: 3, initialDelayMs: 1000 },
        (error) => {
          // Only retry on network errors
          const message =
            error instanceof Error ? error.message : String(error);
          return message.includes("timeout") || message.includes("network");
        }
      );
    },
    async () => {
      // Fallback: Use rule-based analysis
      console.warn("[analyst] LLM failed, using rule-based fallback");
      return generateRuleBasedInsights();
    }
  );
}

function generateRuleBasedInsights(): string {
  // Simple rule-based fallback when LLM fails
  return "- Habit Label: Regular Activity; Evidence: System operating in fallback mode; Counsel: Log more transactions for insights.";
}
```

### 5. Inter-Agent Conversation Example

Create a "group chat" style interaction:

```typescript
// Dev detects unusual spending pattern
messageBus.send({
  from: "dev",
  to: "param",
  type: "question",
  payload: {
    question:
      "Detected INR 5000 food expense - is this a celebration or overspending?",
    transaction: {
      amount: 5000,
      category: "Food & Dining",
      date: "2025-10-18",
    },
  },
  conversationId: "conv_123",
});

// Param responds after analyzing patterns
messageBus.registerHandler("param", "question", async (message) => {
  const { question, transaction } = message.payload as any;

  // Analyze transaction in context
  const transactions = await loadTransactions();
  const avgFood =
    transactions
      .filter((t) => t.category === "Food & Dining")
      .reduce((sum, t) => sum + t.amount, 0) / transactions.length;

  const analysis =
    transaction.amount > avgFood * 3 ? "likely celebration" : "regular pattern";

  // Send response to Coach for advice
  await messageBus.send({
    from: "param",
    to: "chatur",
    type: "request",
    payload: {
      analysis,
      pattern: "High food spending detected",
      evidence: `INR ${transaction.amount} vs average INR ${avgFood.toFixed(
        2
      )}`,
    },
    conversationId: message.conversationId,
  });

  return null;
});

// Coach generates guidance
messageBus.registerHandler("chatur", "request", async (message) => {
  const { analysis, pattern, evidence } = message.payload as any;

  const advice =
    analysis === "likely celebration"
      ? "Celebration expenses are fine! Just keep them occasional."
      : "Consider reviewing your food budget to ensure sustainability.";

  // Send to Mill for user notification
  await messageBus.send({
    from: "chatur",
    to: "mill",
    type: "notification",
    payload: {
      headline: "Spending Pattern Alert",
      message: advice,
      evidence,
    },
    conversationId: message.conversationId,
  });

  return null;
});
```

### 6. Conversational Coach Integration

```typescript
// In chatbot session, detect coaching requests
if (
  userInput.toLowerCase().includes("advice") ||
  userInput.includes("help me budget")
) {
  const insights = await loadHabitRecords();

  // Start conversational session
  const conversation = conversationalCoach.startConversation({
    insights,
    initialQuestion:
      "I'd love to help! What's your main financial challenge right now?",
  });

  output.write(`mill> ${conversation.currentQuestion}\n`);

  // Store session ID for follow-ups
  activeCoachingSessionId = conversation.sessionId;
}

// Handle follow-up responses
if (activeCoachingSessionId) {
  const result = await conversationalCoach.continueConversation(
    activeCoachingSessionId,
    userInput
  );

  output.write(`mill> ${result.message}\n`);

  if (result.completed && result.guidance) {
    output.write(`\n✨ Final Guidance:\n`);
    output.write(`📌 ${result.guidance.headline}\n`);
    output.write(`💡 ${result.guidance.counsel}\n\n`);
    activeCoachingSessionId = undefined;
  }
}
```

## Testing the Enhancements

### Test 1: Smart Routing

```typescript
// Test various user inputs
const testInputs = [
  "How much did I spend on food?",
  "I spent 500 on groceries",
  "Give me advice on saving money",
  "Analyze my spending patterns",
];

for (const input of testInputs) {
  const routing = await orchestrator.route(input);
  console.log(`Input: "${input}"`);
  console.log(`→ Route to: ${routing.primaryAgent}`);
  console.log(`→ Reason: ${routing.reasoning}\n`);
}
```

### Test 2: Message Bus

```typescript
// Simulate inter-agent conversation
messageBus.on("message", (msg: AgentMessage) => {
  console.log(`[${msg.from} → ${msg.to}] ${msg.type}:`, msg.payload);
});

await messageBus.send({
  from: "mill",
  to: "dev",
  type: "request",
  payload: { action: "check_duplicates" },
});
```

### Test 3: Circuit Breaker

```typescript
// Test circuit breaker behavior
const breaker = getCircuitBreaker("test-breaker", { failureThreshold: 3 });

for (let i = 0; i < 10; i++) {
  try {
    await breaker.execute(async () => {
      if (Math.random() > 0.5) throw new Error("Random failure");
      return "success";
    });
    console.log(`Attempt ${i + 1}: Success`);
  } catch (error) {
    console.log(`Attempt ${i + 1}: Failed - ${breaker.getState()}`);
  }
}
```

### Test 4: Conversational Coach

```typescript
const insights: HabitInsight[] = [
  {
    habitLabel: "Frequent Food Spending",
    evidence: "INR 3000 in 7 days",
    counsel: "Consider meal planning",
    fullText:
      "- Habit Label: Frequent Food Spending; Evidence: INR 3000 in 7 days; Counsel: Consider meal planning.",
  },
];

const coach = new ConversationalCoach();
const session = coach.startConversation({ insights });

console.log("Coach:", session.currentQuestion);

let result = await coach.continueConversation(
  session.sessionId,
  "I want to save more money"
);
console.log("Coach:", result.message);

result = await coach.continueConversation(
  session.sessionId,
  "Mostly on food and entertainment"
);
console.log("Coach:", result.message);

if (result.completed && result.guidance) {
  console.log("\nFinal Guidance:", result.guidance);
}
```

## Performance Considerations

1. **Message Bus**: In-memory, no latency overhead
2. **Smart Routing**: Cached for 60s to reduce LLM calls
3. **Circuit Breaker**: Prevents cascading failures, minimal overhead
4. **Atomic CSV**: ~2-5ms overhead per write (acceptable for local)
5. **Conversational Coach**: One LLM call per turn (can be batched)

## Migration Checklist

- [ ] Replace `appendFile` with `csvWriter.append()` in dev-agent.ts
- [ ] Add circuit breakers to all LLM calls (analyst, coach, chatbot)
- [ ] Initialize message bus in chatbot-session.ts
- [ ] Register message handlers for each agent
- [ ] Integrate orchestrator for user input routing
- [ ] Add conversational coach for advice requests
- [ ] Test inter-agent messaging with sample scenarios
- [ ] Add error logging for all circuit breaker trips
- [ ] Update tests to cover new error handling paths

## Estimated Effort

- Message Bus Integration: 2 hours
- Smart Routing: 2 hours
- Error Handling: 2 hours
- Atomic CSV: 1 hour
- Conversational Coach: 3 hours
- Testing & Debugging: 2-3 hours

**Total: 12-13 hours** (fits your timeline!)

## Next Steps

1. Start with Atomic CSV (lowest risk, immediate benefit)
2. Add Error Handling to existing LLM calls
3. Integrate Message Bus for basic inter-agent communication
4. Add Smart Routing for user input
5. Implement Conversational Coach for enhanced UX
6. Test full workflow with all components
