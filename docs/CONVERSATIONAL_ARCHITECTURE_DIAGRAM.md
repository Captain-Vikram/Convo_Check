# Conversational Agent System Architecture

## System Overview Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                          USER INPUT                              │
│                    "I spent 500 on food"                         │
│                    "How can I save money?"                       │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
        ┌────────────────────────────────────────┐
        │    CONVERSATION ROUTER                 │
        │  - Analyzes intent                     │
        │  - Routes to appropriate agent         │
        │  - Manages agent switches              │
        │  - Preserves context                   │
        └────────┬──────────────────┬────────────┘
                 │                  │
    ┌────────────▼──────┐      ┌───▼─────────────┐
    │      MILL         │      │     CHATUR      │
    │  (Transaction     │◄────►│  (Financial     │
    │   Specialist)     │      │    Coach)       │
    └────────┬──────────┘      └───┬─────────────┘
             │                     │
             │                     │
    ┌────────▼──────────┐    ┌────▼────────────┐
    │  TOOLS:           │    │  INSIGHTS:      │
    │  • log_cash_tx    │    │  • Param habits │
    │  • query_summary  │    │  • User goals   │
    └────────┬──────────┘    └─────────────────┘
             │
             ▼
    ┌─────────────────────────────┐
    │    DEV PIPELINE             │
    │  → transactions.csv         │
    │  → analyst-metadata.csv     │
    └─────────────────────────────┘
```

## Routing Decision Flow

```
User Input: "I spent 500 on groceries"
    │
    ▼
[Router analyzes]
    │
    ├─ Has amount? YES
    ├─ Transaction keyword? YES (spent)
    ├─ Advice keyword? NO
    │
    ▼
Route to: MILL
    │
    ▼
Mill: "Got it! Logging INR 500 for groceries. ✨"
```

```
User Input: "How can I reduce my food expenses?"
    │
    ▼
[Router analyzes]
    │
    ├─ Has amount? NO
    ├─ Transaction keyword? NO
    ├─ Advice keyword? YES (reduce, expenses)
    │
    ▼
Route to: CHATUR
    │
    ▼
Chatur: "Let's work on that! What's your weekly food budget? 💡"
```

## Agent Escalation Flow

### Mill → Chatur Escalation

```
┌─────────────────────────────────────────────────┐
│ User with MILL                                  │
├─────────────────────────────────────────────────┤
│ User: "I spent 500 on food"                     │
│ Mill: "Logged! ✨"                              │
│                                                 │
│ User: "Is that too much? Should I reduce it?"  │
│ Mill: [Detects advice request]                 │
│       "Great question! Let me connect you      │
│        with Chatur for advice. 💡"             │
└────────────────┬────────────────────────────────┘
                 │
        [Escalation occurs]
                 │
                 ▼
┌─────────────────────────────────────────────────┐
│ User now with CHATUR                            │
├─────────────────────────────────────────────────┤
│ Chatur: "Hi! I'm Chatur. Let's analyze your    │
│          food spending. What's your typical     │
│          weekly amount?"                        │
│                                                 │
│ User: "Around 2000 per week"                    │
│ Chatur: "That's INR 8000/month. Let's create   │
│          a plan to reduce it..."                │
└─────────────────────────────────────────────────┘
```

### Chatur → Mill Escalation

```
┌─────────────────────────────────────────────────┐
│ User with CHATUR                                │
├─────────────────────────────────────────────────┤
│ User: "Help me budget my income"                │
│ Chatur: "Great! What's your monthly income? 💡" │
│                                                 │
│ User: "I just got paid 25000 today"            │
│ Chatur: [Detects transaction mention]          │
│         "Let me connect you with Mill to log   │
│          that first. 📝"                        │
└────────────────┬────────────────────────────────┘
                 │
        [Escalation occurs]
                 │
                 ▼
┌─────────────────────────────────────────────────┐
│ User now with MILL                              │
├─────────────────────────────────────────────────┤
│ Mill: "Perfect! INR 25000 income. Let me log   │
│        that. ✨ [Transaction saved]"            │
│                                                 │
│ Mill: "All set! Going back to Chatur for       │
│        your budgeting session."                 │
└────────────────┬────────────────────────────────┘
                 │
        [Return to Chatur]
                 │
                 ▼
┌─────────────────────────────────────────────────┐
│ User back with CHATUR                           │
├─────────────────────────────────────────────────┤
│ Chatur: "Great! With INR 25000/month, let's    │
│          allocate: 50% needs, 30% wants,       │
│          20% savings..."                        │
└─────────────────────────────────────────────────┘
```

## Conversation State Machine

### Mill's States

```
START
  │
  ▼
DETECTING_INTENT ───┐
  │                 │
  ├─ logging ───────┤
  ├─ query ─────────┤
  ├─ advice ────────┼──► ESCALATE_TO_CHATUR
  └─ unclear ───────┘
  │
  ▼
COLLECTING_INFO
  │
  ├─ Has amount? NO ──► ASK_FOR_AMOUNT
  ├─ Has desc? NO ────► ASK_FOR_DESCRIPTION
  └─ Complete? YES ───► EXECUTE_ACTION
                          │
                          ▼
                        DONE
```

### Chatur's States

```
START
  │
  ▼
DETECTING_GOAL
  │
  ├─ Save money
  ├─ Reduce spending
  ├─ Budget planning
  └─ General advice
  │
  ▼
GATHERING_CONTEXT (Turn 1-3)
  │
  ├─ What's the problem?
  ├─ What's the goal?
  ├─ What are constraints?
  │
  ├─ User mentions transaction? ──► ESCALATE_TO_MILL
  │
  ▼
PROVIDING_GUIDANCE (Turn 4)
  │
  └─► DONE (with final action plan)
```

## Data Flow with Conversations

```
┌──────────────────────────────────────────────────┐
│ 1. User speaks to Router                         │
└───────────────┬──────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────┐
│ 2. Router analyzes & routes to Mill/Chatur      │
└───────────────┬──────────────────────────────────┘
                │
       ┌────────┴─────────┐
       │                  │
       ▼                  ▼
┌─────────────┐    ┌──────────────┐
│ 3a. MILL    │    │ 3b. CHATUR   │
│ - Extracts  │    │ - Asks about │
│   tx details│    │   goals      │
│ - Multi-turn│    │ - Multi-turn │
└──────┬──────┘    └──────┬───────┘
       │                  │
       │                  ▼
       │           ┌──────────────┐
       │           │ 4b. Reads    │
       │           │ Param habits │
       │           └──────┬───────┘
       │                  │
       ▼                  ▼
┌─────────────────────────────────┐
│ 5a. Mill calls Dev pipeline     │
│     → transactions.csv           │
│     → analyst-metadata.csv       │
└─────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────┐
│ 6. Param runs analysis          │
│    → habits.csv                 │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│ 7. Chatur generates guidance    │
│    → coach-briefings.json       │
└─────────────────────────────────┘
```

## Keyword Routing Matrix

| User Input Contains          | Agent  | Reason             |
| ---------------------------- | ------ | ------------------ |
| Amount (500, 1000)           | Mill   | Transaction likely |
| "spent", "paid", "bought"    | Mill   | Transaction verbs  |
| "show", "how much", "total"  | Mill   | Data query         |
| "advice", "tip", "help me"   | Chatur | Seeking guidance   |
| "should I", "what to do"     | Chatur | Decision support   |
| "goal", "save", "reduce"     | Chatur | Goal-oriented      |
| "budget", "plan", "strategy" | Chatur | Planning needed    |
| Ambiguous                    | None   | Let user choose    |

## Session Management

```
┌─────────────────────────────────────────────┐
│ ConversationRouter maintains:              │
├─────────────────────────────────────────────┤
│ Map<userId, {                               │
│   activeAgent: "mill" | "chatur",          │
│   millSessionId?: string,                  │
│   chaturSessionId?: string,                │
│   conversationHistory: [                   │
│     {                                       │
│       agent: "mill",                       │
│       userMsg: "I spent 500",              │
│       agentMsg: "Logging...",              │
│       timestamp: "2025-10-18T12:00:00Z"    │
│     },                                      │
│     ...                                     │
│   ]                                         │
│ }>                                          │
└─────────────────────────────────────────────┘
```

## Performance Characteristics

```
Operation Timeline:
─────────────────────────────────────────────────
User Input                                    [0ms]
  │
  ▼
Router Keyword Analysis                      [1ms]
  │
  ├─ Cache hit ────────────────────►       [1ms]
  │
  └─ LLM call ─────────────────────►     [500ms]
      │
      ▼
Agent Selection                              [1ms]
  │
  ▼
Agent LLM Call                            [1000ms]
  │
  ▼
Response to User                          [1002ms]

Total: ~1-1.5 seconds (with LLM)
Total: ~50ms (with caching)
```

## Error Handling Flow

```
User Input
  │
  ▼
Router
  │
  ├─ LLM fails? ──► Keyword fallback ─────► Agent
  │
  ▼
Agent
  │
  ├─ LLM fails? ──► Rule-based response ──► User
  │
  ├─ Tool fails? ─► Retry (3x) ───────────► User
  │
  └─ Success ─────────────────────────────► User

All paths lead to user response (graceful degradation)
```

## Monitoring Points

```
┌──────────────────────────────────────────────┐
│ Track these metrics:                         │
├──────────────────────────────────────────────┤
│ 1. Agent selection accuracy                  │
│    - Mill vs Chatur routing correctness      │
│                                              │
│ 2. Escalation frequency                      │
│    - How often agents hand off              │
│                                              │
│ 3. Conversation length                       │
│    - Average turns per conversation          │
│                                              │
│ 4. Completion rate                           │
│    - % of conversations that complete        │
│                                              │
│ 5. LLM fallback rate                         │
│    - % using keyword-based routing           │
│                                              │
│ 6. Response latency                          │
│    - P50, P95, P99 response times           │
└──────────────────────────────────────────────┘
```

## Summary

This architecture achieves:

✅ **Clear Separation**: Mill handles transactions, Chatur handles advice  
✅ **Intelligent Routing**: System decides which agent based on intent  
✅ **Seamless Handoffs**: Agents collaborate without user confusion  
✅ **Graceful Degradation**: Fallbacks at every layer  
✅ **Observable**: Full conversation history tracked  
✅ **Scalable**: Easy to add more specialized agents

Perfect for production deployment! 🚀
