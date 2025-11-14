# Agent System Documentation Index 🤖

## Overview

This financial assistant system consists of **5 specialized AI agents** working together to provide comprehensive financial management, analysis, coaching, and shopping assistance.

---

## The Agent Team

### 1. Mill - The Financial Sidekick 💰
**Role**: Transaction Logger & Chatbot  
**Personality**: Witty, encouraging, meme-savvy friend  
**Primary Functions**:
- Logs cash transactions
- Queries spending history
- Explains financial concepts
- Routes to specialized agents

📄 **[Full Documentation](./MILL_AGENT.md)**

**When to use**: First point of contact, transaction logging, spending queries, financial education

---

### 2. Dev - The SMS Transaction Parser 📱
**Role**: Automated Transaction Extractor  
**Personality**: Silent, precise, data processor  
**Primary Functions**:
- Extracts transactions from banking SMS
- Normalizes transaction data
- Filters out spam/OTP messages
- Feeds data to other agents

📄 **[Full Documentation](./DEV_AGENT.md)**

**When to use**: Background processing of SMS alerts (users never interact directly)

---

### 3. Param - The Financial Analyst 📊
**Role**: Pattern Detection & Insights Generator  
**Personality**: Data-driven, observant, precise  
**Primary Functions**:
- Identifies spending/saving patterns
- Generates actionable insights
- Creates habit snapshots
- Provides evidence for coaching

📄 **[Full Documentation](./PARAM_AGENT.md)**

**When to use**: Behind-the-scenes analysis (users see insights through Mill/Chatur)

---

### 4. Chatur - The Financial Coach 🎯
**Role**: Decision Advisor & Goal Planner  
**Personality**: Supportive, strategic, mentor  
**Primary Functions**:
- Evaluates purchase decisions
- Plans financial goals
- Provides loan/EMI guidance
- Builds on Param's insights for coaching

📄 **[Full Documentation](./CHATUR_AGENT.md)**

**When to use**: Financial advice, goal setting, purchase decisions, loan planning

---

### 5. Sera - The Shopping Assistant 🛍️
**Role**: Product Search & Deal Finder  
**Personality**: Enthusiastic, deal-hunting friend  
**Primary Functions**:
- Searches products across Indian e-commerce
- Compares prices and specs
- Manages wishlist
- Provides shopping guidance

📄 **[Full Documentation](./SERA_AGENT.md)**

**When to use**: Product shopping, price comparison, deal hunting, wishlist tracking

---

## Agent Interaction Map

```
                    ┌─────────────┐
                    │    USER     │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │    MILL     │ ◄── Entry Point
                    │  (Chatbot)  │
                    └──┬─────┬─┬──┘
                       │     │ │
        ┌──────────────┘     │ └──────────────┐
        │                    │                │
   ┌────▼────┐          ┌───▼────┐      ┌────▼────┐
   │ CHATUR  │          │ PARAM  │      │  SERA   │
   │ (Coach) │ ◄────────┤(Analyst)       │(Shopping)
   └─────────┘          └────────┘      └─────┬───┘
                             ▲                 │
                             │                 │
                        ┌────┴────┐            │
                        │   DEV   │            │
                        │  (SMS)  │            │
                        └─────────┘            │
                                               │
                                          ┌────▼────┐
                                          │ CHATUR  │
                                          │(Budget) │
                                          └─────────┘
```

### Data Flow Legend:
- **Solid lines**: Direct user interaction or agent transfer
- **Dashed lines**: Background data flow (no direct communication)

---

## Agent Relationships

### Mill ↔ Users
- **Direction**: Bidirectional
- **Type**: Primary conversational interface
- **Flow**: User messages → Mill responses, tool calls, agent transfers

### Mill → Chatur
- **Trigger**: User asks for advice, "should I buy...", goal setting
- **Type**: Explicit transfer with context
- **Example**: "Let me bring in Chatur, our financial coach..."

### Mill → Sera
- **Trigger**: User wants to shop, "find me...", product search
- **Type**: Explicit transfer with introduction
- **Example**: "Sera is THE expert at finding great deals!"

### Param → Mill
- **Direction**: Param provides, Mill displays
- **Type**: Data inclusion in spending queries
- **Flow**: Mill queries DB → includes Param's insights → shows to user

### Param → Chatur
- **Direction**: Param provides foundation, Chatur builds coaching
- **Type**: Insights consumption for personalized advice
- **Flow**: Chatur fetches Param insights → builds recommendations

### Dev → Database → All Agents
- **Direction**: Dev extracts → stores → agents consume
- **Type**: Background data pipeline
- **Flow**: SMS → Dev → Transactions DB → Available to Mill/Param/Chatur

### Sera ↔ Chatur
- **Direction**: Bidirectional transfers
- **Sera → Chatur**: "Should I buy this?" questions
- **Chatur → Sera**: "Approved to shop, find options"

---

## Communication Patterns

### Direct User Interaction
| Agent | User Interaction | Conversation Style |
|-------|-----------------|-------------------|
| **Mill** | ✅ Primary | Witty, friendly, casual |
| **Dev** | ❌ None | Silent (background) |
| **Param** | ❌ Indirect | Users see insights via Mill/Chatur |
| **Chatur** | ✅ Coaching | Strategic, supportive, goal-focused |
| **Sera** | ✅ Shopping | Enthusiastic, bubbly, deal-focused |

### Inter-Agent Communication
- **Message Bus**: `agent-message-bus.ts` for async communication
- **Conversation Router**: `conversation-router.ts` for intelligent routing
- **Agent Orchestrator**: `agent-orchestrator.ts` for session management

---

## Use Case Flows

### Flow 1: Manual Transaction Logging
```
User: "Spent ₹500 on coffee"
  ↓
Mill: Extracts details, calls log_cash_transaction tool
  ↓
Database: Stores transaction
  ↓
Mill: "Got it! ₹500 for coffee, logged and loaded. ☕️"
```

### Flow 2: Automated SMS Transaction
```
Bank SMS: "₹1,250 debited to Swiggy via UPI"
  ↓
Dev: Parses SMS, extracts transaction data
  ↓
Database: Stores transaction
  ↓
[User later asks Mill about spending]
  ↓
Mill: Includes Swiggy transaction in spending summary
```

### Flow 3: Spending Analysis
```
User: "How's my spending this month?"
  ↓
Mill: Calls query_spending_summary
  ↓
Param: Analyzes transactions → Generates insights
  ↓
Mill: Presents data + Param's insights to user
```

### Flow 4: Financial Coaching
```
User: "Should I buy ₹15K phone?"
  ↓
Mill: Recognizes advice need, transfers to Chatur
  ↓
Chatur: Fetches Param insights + transaction history
  ↓
Chatur: Evaluates affordability, provides recommendation
  ↓
User: Receives personalized coaching advice
```

### Flow 5: Shopping Assistance
```
User: "Find me a laptop"
  ↓
Mill: Recognizes shopping need, transfers to Sera
  ↓
Sera: Gathers requirements (budget, specs, usage)
  ↓
Sera: Searches Google Shopping via SerpAPI
  ↓
Sera: Presents results, helps compare options
  ↓
User: Decides on product
  ↓
Sera: Offers to add to wishlist or transfer to Chatur for budget check
```

### Flow 6: Complete Purchase Journey
```
User: "I want to buy a phone"
  ↓
Mill → Sera (transfer)
  ↓
Sera: "What's your budget?"
User: "₹30K"
  ↓
Sera: Searches, shows options
  ↓
User: "Should I buy this ₹28K one?"
  ↓
Sera → Chatur (transfer for budget check)
  ↓
Chatur: Analyzes affordability
"Yes, fits your budget. You earn ₹50K/month, have ₹15K savings. Go for it!"
  ↓
User: Confident purchase decision ✅
```

---

## Technical Architecture

### System Components

#### 1. Agent Definitions
- Location: `src/agents/`
- Files: `chatbot.ts`, `dev.ts`, `analyst.ts`, `coach.ts`, `sera.ts`
- Purpose: Define agent identity, system prompts, available tools

#### 2. Runtime Logic
- Location: `src/runtime/`
- Folders: `mill/`, `dev/`, `param/`, `chatur/`, `sera/`
- Purpose: Implement agent behavior, session management, tool execution

#### 3. Shared Infrastructure
- Location: `src/runtime/shared/`
- Components:
  - `agent-message-bus.ts` - Inter-agent communication
  - `conversation-router.ts` - Intelligent routing
  - `agent-orchestrator.ts` - Session orchestration
  - `logger.ts` - System logging

#### 4. Tools
- Location: `src/tools/`
- Files: 
  - `log-cash-transaction.ts` - Transaction logging
  - `query-spending-summary.ts` - Data retrieval
  - `web-search.ts` - Financial definitions
  - `sera.ts` - Shopping tools
  - `expense-analyzer.ts` - Analysis utilities
  - `financial-calculator.ts` - Loan/EMI math

#### 5. Database Layer
- **Web API**: `web/src/app/api/` - REST endpoints
- **Prisma ORM**: `data/schema.prisma` - Database schema
- **Tables**: transactions, alerts, habit_insights, habit_snapshots, coach_briefings, shopping_wishlist, sms_messages, users

---

## Configuration

### Environment Variables

#### Agent API Keys
```bash
CHATBOT_GEMINI_API_KEY=<mill-key>
ACCOUNTANT_GEMINI_API_KEY=<dev-key>
ANALYST_GEMINI_API_KEY=<param-key>
COACH_GEMINI_API_KEY=<chatur-key>
SERA_GEMINI_API_KEY=<sera-key>
```

#### External Services
```bash
SERPAPI_KEY=<shopping-search-key>
DATABASE_URL=postgresql://...
```

#### System Config
```bash
WEB_API_URL=http://localhost:3000
SERVICE_API_TOKEN=<service-token>
DEV_USER_ID=2
JWT_SECRET=<jwt-secret>
CRON_SECRET=<cron-secret>
```

---

## Deployment

### Production Setup

1. **Web Server** (Vercel/Node.js)
   - Hosts REST API endpoints
   - Manages database connections
   - Handles authentication

2. **CLI Agents** (Optional local deployment)
   - Mill, Chatur, Sera for WhatsApp/chat interface
   - Dev for SMS processing cron jobs

3. **Database** (PostgreSQL)
   - Hosted at 157.180.67.45:5432
   - Directus-compatible schema
   - Stores all agent data

### Architecture Benefits
- **Separation**: Web API decoupled from CLI agents
- **Scalability**: Each agent can scale independently
- **Maintainability**: Clear responsibilities per agent
- **Flexibility**: Easy to add/modify agents

---

## Development Guide

### Adding a New Agent

1. **Create Agent Definition** (`src/agents/new-agent.ts`)
   ```typescript
   export const newAgent: AgentDefinition = {
     ...descriptor,
     systemPrompt: "Your agent's personality and instructions",
     tools: [/* tool definitions */]
   };
   ```

2. **Implement Runtime Logic** (`src/runtime/new-agent/`)
   - Agent behavior
   - Tool implementations
   - Session management

3. **Register in Router** (`src/runtime/shared/conversation-router.ts`)
   - Add keywords for routing
   - Define transfer logic

4. **Create Tools** (`src/tools/new-agent-tools.ts`)
   - Tool definitions
   - Executor functions

5. **Update Documentation**
   - Create agent doc in `docs/agents/`
   - Update this index

### Testing Agents

```bash
# Test individual agent
npm run dev

# Test agent interactions
# (Implement test scenarios in test files)

# Test database integration
npm run build
```

---

## Best Practices

### For Developers

1. **Single Responsibility**: Each agent has one clear purpose
2. **Loose Coupling**: Agents communicate via message bus, not direct calls
3. **Consistent Personality**: Maintain agent character in all responses
4. **Error Handling**: Graceful failures, user-friendly errors
5. **Logging**: Use logger for debugging, don't expose internals to users

### For Agent Design

1. **Clear System Prompts**: Explicit instructions, examples
2. **Tool Definitions**: Descriptive parameters, clear purposes
3. **User-Centric**: Always prioritize user experience
4. **Context Awareness**: Use conversation history, user data
5. **Ethical Boundaries**: Disclaimers, privacy, safety

---

## Monitoring & Maintenance

### Health Checks

- **Mill**: Response time, tool success rate
- **Dev**: SMS processing rate, extraction accuracy
- **Param**: Insight quality, analysis completeness
- **Chatur**: Coaching effectiveness, goal progress
- **Sera**: Search success rate, wishlist engagement

### Logs

- **Location**: Console output (development), structured logs (production)
- **Components**: agent-id, action, timestamp, context
- **Monitoring**: Track errors, tool failures, API limits

### Performance Metrics

- **Agent Response Time**: <2s for simple queries, <5s for complex
- **Tool Execution**: <1s for database, <3s for external APIs
- **User Engagement**: Conversation length, return rate
- **Goal Completion**: Successful purchases, savings milestones

---

## Troubleshooting

### Common Issues

**Issue**: Agent not responding
- Check: Gemini API key valid, quota available
- Check: System prompt not too long
- Check: Tool definitions correct

**Issue**: Agent transfers failing
- Check: Conversation router keywords
- Check: Message bus communication
- Check: Session IDs preserved

**Issue**: Tools failing
- Check: Database connection
- Check: API authentication
- Check: Parameter validation

**Issue**: Insights not showing
- Check: Param ran successfully
- Check: Database stores insights
- Check: Mill queries include insights

---

## Future Roadmap

### Phase 1: Enhanced Intelligence
- Multi-turn context retention
- Proactive suggestions (unsolicited advice)
- Predictive analytics (future spending)

### Phase 2: Extended Capabilities
- Voice interface integration
- Receipt OCR (image transactions)
- Bank API connections (auto-import)

### Phase 3: Social Features
- Family financial planning (shared goals)
- Peer benchmarking (anonymized)
- Community challenges (savings competitions)

### Phase 4: Advanced Coaching
- Investment basics education
- Tax planning assistance
- Retirement planning
- Debt management strategies

---

## Resources

### Documentation
- [API Documentation](../API_DOCUMENTATION.md)
- [Database Schema](../../data/schema.prisma)
- [Setup Instructions](../../README.md)

### Individual Agent Docs
- [Mill - Financial Sidekick](./MILL_AGENT.md)
- [Dev - SMS Parser](./DEV_AGENT.md)
- [Param - Analyst](./PARAM_AGENT.md)
- [Chatur - Coach](./CHATUR_AGENT.md)
- [Sera - Shopping Assistant](./SERA_AGENT.md)

### External Resources
- [Gemini API Documentation](https://ai.google.dev/docs)
- [SerpAPI Documentation](https://serpapi.com/docs)
- [Vercel AI SDK](https://sdk.vercel.ai/docs)
- [Prisma Documentation](https://www.prisma.io/docs)

---

## Support & Contact

For questions, issues, or contributions:
- Review agent-specific documentation first
- Check troubleshooting section
- Examine code comments and examples
- Test in development environment before production

---

**System Version**: 1.0.0  
**Last Updated**: November 14, 2025  
**Status**: Production Ready ✅

**Agent Status**:
- Mill: ✅ Operational
- Dev: ✅ Operational (SMS processing)
- Param: ✅ Operational (background analysis)
- Chatur: ✅ Operational (coaching)
- Sera: ✅ Operational (shopping)

---

## Quick Reference

| Need | Agent | Action |
|------|-------|--------|
| Log transaction | Mill | "Spent ₹X on Y" |
| Check spending | Mill | "Show my spending" |
| Financial advice | Chatur | "Should I buy X?" |
| Set goal | Chatur | "I want to save for X" |
| Shop for product | Sera | "Find me X" |
| Compare prices | Sera | "Compare X and Y" |
| Save for later | Sera | "Add to wishlist" |
| Learn concept | Mill | "What is X?" |

**Remember**: Start with Mill for everything, they'll route you to the right specialist! 🎯
