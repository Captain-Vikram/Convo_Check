# Convo Check - Multi-Agent Financial Assistant System

AI-powered financial assistant featuring a multi-agent architecture with conversational transaction logging, SMS parsing, automated habit analysis, personalized financial coaching, and smart shopping assistance.

## 🎯 Overview

Convo Check is a comprehensive financial management system that helps users (especially gig workers) manage finances through intelligent automation and conversational AI. Built with a **5-agent architecture** working together seamlessly via REST APIs and PostgreSQL database.

### 🤖 The Agent Team

1. **Mill (Financial Sidekick)** 💰 - Witty chatbot for logging transactions, querying spending, and explaining financial concepts
2. **Dev (SMS Parser)** 📱 - Silent background agent that extracts transactions from banking SMS automatically
3. **Param (Analyst)** 📊 - Data-driven pattern detector that identifies spending habits and generates actionable insights
4. **Chatur (Financial Coach)** 🎯 - Strategic advisor for purchase decisions, goal planning, and loan guidance
5. **Sera (Shopping Assistant)** 🛍️ - Enthusiastic deal-hunter for product search, price comparison, and wishlist management

## 🚀 Features

### Core Capabilities

- ✅ **Conversational Transaction Logging** - Natural language expense/income tracking with Mill
- ✅ **Automated SMS Parsing** - Dev extracts transactions from bank SMS (UPI, cards, NEFT)
- ✅ **Intelligent Pattern Detection** - Param identifies spending habits and behavioral flags
- ✅ **Personalized Financial Coaching** - Chatur provides purchase advice and goal planning
- ✅ **Smart Shopping Assistant** - Sera searches products, compares prices, manages wishlist
- ✅ **Multi-Agent Coordination** - Agents communicate via message bus and share insights
- ✅ **REST API Architecture** - Clean separation between web server and CLI agents
- ✅ **PostgreSQL Database** - Directus-compatible schema with full CRUD operations
- ✅ **Financial Education** - Mill explains concepts (SIP, compound interest, etc.) via web search
- ✅ **Loan Planning** - Chatur calculates EMI, affordability, and provides 3-lever strategies

### Agent-Specific Features

**Mill** 💰

- Transaction logging with smart categorization
- Spending history queries with Param insights
- Financial concept explanations (web-powered)
- Agent routing and coordination

**Dev** 📱

- Background SMS processing (cron-based)
- Multi-bank format support (BOB, ICICI, HDFC, Paytm, etc.)
- Data normalization and validation
- Noise filtering (OTPs, marketing, balance alerts)

**Param** 📊

- 5-7 actionable habit insights per analysis
- Evidence-based recommendations (<220 chars each)
- Habit snapshot creation for historical tracking
- Behavioral flag detection (overspending, impulse buying, etc.)

**Chatur** 🎯

- Purchase decision framework (affordability, timing, opportunity cost)
- Goal planning with progress tracking
- Loan/EMI calculations with multiple tenure options
- 3-lever optimization (save more, earn more, extend timeline)

**Sera** 🛍️

- Google Shopping search across Indian e-commerce
- Product comparison with ratings and specs
- Wishlist management with target price tracking
- Amazon product lookup for detailed info

## 📋 Prerequisites

- Node.js 20+
- npm 10+
- PostgreSQL database (hosted or local)
- Google Gemini API keys (5 agents)
- SerpAPI key (for web search/shopping)

## 🛠️ Setup

```bash
# Clone repository
git clone https://github.com/Captain-Vikram/Convo_Check.git
cd Convo_Check

# Install root dependencies
npm install

# Install web dependencies
cd web
npm install
cd ..

# Configure environment
cp .env.example .env
# Edit .env and add:
# - Database connection (DATABASE_URL)
# - Gemini API keys (5 agents)
# - SerpAPI key
# - JWT secret
# - Service API token
# - Cron secret

# Generate Prisma client
npx prisma generate --schema=./data/schema.prisma

# Build project
npm run build
```

## 🗄️ Database Setup

The system uses PostgreSQL with Prisma ORM. Schema is Directus-compatible.

```bash
# Run migrations (if needed)
# Prisma will auto-sync schema on first connection

# Verify connection
# Start web server and check /api/transactions endpoint
```

**Database Tables**:

- `transactions` - All financial transactions
- `alerts` - Financial alerts and notifications
- `habit_insights` - Individual habit patterns (from Param)
- `habit_snapshots` - Aggregated behavior snapshots
- `coach_briefings` - Coaching advice (from Chatur)
- `shopping_wishlist` - Sera's product wishlist
- `sms_messages` - Raw SMS data for processing
- `users` - User accounts

## 🎮 Usage

### Development Mode

```bash
# Start web server (includes API endpoints)
cd web
npm run dev
# Server runs on http://localhost:3000

# In another terminal, start CLI agent (Mill/Chatur/Sera)
npm run dev
# Interactive chat interface
```

### Production Deployment

**Option 1: Vercel (Recommended)**

```bash
cd web
vercel deploy
# Configure environment variables in Vercel dashboard
```

**Option 2: Node.js Server**

```bash
npm run build
cd web
npm run build
npm start
# Production server on port 3000
```

### Interacting with Agents

**Mill (Financial Sidekick)**:

```
you> Hey Mill!
Mill> Hey! 👋 What's up? I can help you log transactions or check your spending.

you> I spent 500 on coffee
Mill> Got it! ₹500 for coffee, logged and loaded. Those beans have you on speed dial ☕️😂

you> Show my spending this month
Mill> [Displays transaction summary with Param's insights]

you> What's compound interest?
Mill> Ahh, compound interest! 🎯 It's money making money making MORE money...
```

**Chatur (Financial Coach)**:

```
you> Should I buy a ₹50,000 laptop?
Chatur> Let's evaluate this together! What's your monthly income?

you> ₹40,000
Chatur> {
  "headline": "Laptop Purchase – Wait 2 Months",
  "counsel": "Save ₹20K/month for 2 months, then buy with ₹5K buffer",
  "evidence": "₹50K is 125% of monthly income. Current savings: ₹15K",
  "decision": "Wait—Build savings first to keep emergency fund intact"
}
```

**Sera (Shopping Assistant)**:

```
you> Find me gaming laptops under ₹80K
Sera> Ooh, laptop shopping! 💻 Let me hunt down the best deals...

[Shows product table with 10 options]

Sera> Found some amazing options! Check the table above ⬆️
Want me to help you compare specific ones?

you> Add the first one to wishlist
Sera> Great choice! What's your target price?

you> ₹70,000
Sera> Saved to your wishlist! 💝 I'll remember this for you.
```

### API Endpoints

See [API_DOCUMENTATION.md](./API_DOCUMENTATION.md) for complete API reference.

**Key Endpoints**:

- `GET /api/transactions` - Fetch transactions
- `POST /api/transactions` - Log new transaction
- `GET /api/habits` - Get habit insights
- `GET /api/coach-briefings` - Get coaching advice
- `POST /api/sms/process-queue` - Process SMS (cron job)
- _Wishlist items are managed directly through Prisma (no public REST API)_

### SMS Processing (Cron Job)

```bash
# Setup cron job to run every 5-15 minutes
# Endpoint: POST /api/sms/process-queue
# Header: x-cron-secret: <CRON_SECRET>

# Or trigger manually:
curl -X POST http://localhost:3000/api/sms/process-queue \
  -H "x-cron-secret: your-cron-secret"
```

## 📁 Project Structure

```
Convo_Check/
├── src/                          # CLI agents source code
│   ├── agents/                   # Agent definitions
│   │   ├── chatbot.ts           # Mill (Financial Sidekick)
│   │   ├── dev.ts               # Dev (SMS Parser)
│   │   ├── analyst.ts           # Param (Analyst)
│   │   ├── coach.ts             # Chatur (Coach)
│   │   └── sera.ts              # Sera (Shopping Assistant)
│   ├── runtime/                  # Agent execution logic
│   │   ├── mill/                # Mill runtime
│   │   ├── dev/                 # Dev runtime (SMS processing)
│   │   ├── param/               # Param runtime (analysis)
│   │   ├── chatur/              # Chatur runtime (coaching)
│   │   ├── sera/                # Sera runtime (shopping)
│   │   └── shared/              # Shared utilities
│   │       ├── agent-message-bus.ts      # Inter-agent communication
│   │       ├── conversation-router.ts     # Intelligent routing
│   │       └── agent-orchestrator.ts      # Session management
│   ├── tools/                    # AI SDK tools
│   │   ├── log-cash-transaction.ts       # Transaction logging
│   │   ├── query-spending-summary.ts     # Data queries
│   │   ├── web-search.ts                 # Financial definitions
│   │   ├── sera.ts                       # Shopping tools
│   │   └── financial-calculator.ts       # Loan/EMI math
│   ├── config.ts                 # Configuration
│   └── index.ts                  # CLI entry point
│
├── web/                          # Next.js web server
│   ├── src/
│   │   └── app/
│   │       └── api/              # REST API endpoints
│   │           ├── transactions/ # Transaction CRUD
│   │           ├── alerts/       # Alerts CRUD
│   │           ├── habits/       # Habit insights CRUD
│   │           ├── coach-briefings/  # Coaching CRUD
│   │           └── sms/          # SMS processing cron
│   ├── middleware.ts             # Authentication
│   └── package.json
│
├── data/                         # Data & schema
│   ├── schema.prisma             # Database schema (PostgreSQL)
│   ├── generated/                # Prisma client
│   └── migrations/               # SQL migrations
│
├── docs/                         # Documentation
│   ├── API_DOCUMENTATION.md      # Complete API reference
│   ├── INDEX.md                  # Project overview
│   └── agents/                   # Agent-specific docs
│       ├── INDEX.md              # Agent system overview
│       ├── MILL_AGENT.md         # Mill documentation
│       ├── DEV_AGENT.md          # Dev documentation
│       ├── PARAM_AGENT.md        # Param documentation
│       ├── CHATUR_AGENT.md       # Chatur documentation
│       └── SERA_AGENT.md         # Sera documentation
│
├── scripts/                      # Utility scripts
│   ├── introspect-schema.ts      # Schema management
│   ├── print-token.ts            # Auth token generator
│   └── apply-performance-indexes.ps1  # DB optimization
│
├── .env.example                  # Environment template
├── package.json                  # Root dependencies
├── tsconfig.json                 # TypeScript config
└── README.md                     # This file
```

## 🤖 Agent Interaction Flow

### Example: User Queries Spending

1. **User asks Mill**: "Show me my spending this month"
2. **Mill calls**: `query_spending_summary` tool
3. **System coordinates**:
   - Fetches transactions from database (`GET /api/transactions`)
   - Loads latest **Param insights** from database (`GET /api/habits`)
   - Retrieves **Chatur's coaching** from database (`GET /api/coach-briefings`)
4. **Mill presents**: Unified response with:
   - Transaction totals and categories
   - Param's analytical insights (5-7 habit bullets)
   - Chatur's personalized coaching tips
   - Interactive follow-up options

### Example: Purchase Decision

1. **User asks Mill**: "Should I buy a ₹50K laptop?"
2. **Mill recognizes**: Needs financial advice
3. **Mill transfers to Chatur**: "Let me bring in our financial coach..."
4. **Chatur analyzes**:
   - Fetches Param's latest spending insights
   - Retrieves transaction history
   - Calculates affordability
5. **Chatur responds**: Structured decision with evidence, counsel, and recommendation
6. **Optional**: Chatur transfers to Sera if user approved to shop

### Example: Shopping Journey

1. **User asks Mill**: "I want to buy headphones"
2. **Mill transfers to Sera**: "Sera is THE expert at finding deals!"
3. **Sera gathers requirements**:
   - Budget: "What's your budget?"
   - Usage: "What will you use them for?"
   - Features: "Any must-haves?"
4. **Sera searches**: Google Shopping via SerpAPI
5. **Sera presents**: Product table with prices, ratings, stores
6. **Sera helps decide**: Compares options, explains specs
7. **User chooses**: "Add the first one to wishlist"
8. **Sera saves**: Persists the item directly via Prisma into `shopping_wishlist`
9. **Sera offers**: "Want to check if it fits your budget with Chatur?"

### Background: SMS Processing

1. **Bank SMS arrives**: "₹500 debited to Swiggy via UPI"
2. **SMS forwarded**: To system inbox/webhook
3. **Stored in DB**: `sms_messages` table, `processed = false`
4. **Cron job runs**: Every 5-15 minutes
5. **Dev processes**: Extracts transaction JSON
6. **Saves to DB**: `transactions` table via `POST /api/transactions`
7. **Marks processed**: `processed = true` in `sms_messages`
8. **Available immediately**: All agents can access new transaction

### Data Flow Diagram

```
User Input → Mill (Router) → [Chatur (Advice) | Sera (Shopping)]
                ↓
         Database (PostgreSQL)
                ↑
    [Param (Analysis) | Dev (SMS Parsing)]
```

## 🔧 Configuration

### Environment Variables

**Required for All Agents**:

```env
# Database
DATABASE_URL=postgresql://user:password@host:port/database

# Authentication
JWT_SECRET=your-jwt-secret-key
SERVICE_API_TOKEN=your-service-api-token
DEV_USER_ID=2

# Web Server
WEB_API_URL=http://localhost:3000
API_KEY=optional-additional-key
```

**Agent-Specific Keys**:

```env
# Mill (Chatbot)
CHATBOT_GEMINI_API_KEY=your-gemini-key

# Dev (SMS Parser)
ACCOUNTANT_GEMINI_API_KEY=your-gemini-key

# Param (Analyst)
ANALYST_GEMINI_API_KEY=your-gemini-key

# Chatur (Coach)
COACH_GEMINI_API_KEY=your-gemini-key

# Sera (Shopping)
SERA_GEMINI_API_KEY=your-gemini-key
SERPAPI_KEY=your-serpapi-key
```

**Optional**:

```env
# SMS Processing
CRON_SECRET=your-cron-secret

# Development
DISABLE_AUTH=0  # Set to 1 for local dev
```

### Gemini Models

All agents use Google Gemini via Vercel AI SDK:

- **Mill**: Gemini 1.5 Flash (fast conversational responses)
- **Dev**: Gemini 1.5 Flash (efficient SMS parsing)
- **Param**: Gemini 1.5 Flash (analytical insights)
- **Chatur**: Gemini 1.5 Flash (coaching and planning)
- **Sera**: Gemini 1.5 Flash (shopping conversation)

## 📊 Architecture Overview

### Technology Stack

- **Backend**: Node.js + TypeScript
- **Web Framework**: Next.js 14+ (App Router)
- **Database**: PostgreSQL with Prisma ORM
- **AI**: Google Gemini (via Vercel AI SDK)
- **Search**: SerpAPI (Google Shopping)
- **Authentication**: JWT + Service Tokens
- **Deployment**: Vercel (recommended) or Node.js

### Key Design Decisions

1. **REST API Architecture**: Clean separation between web server and CLI agents

   - Web server hosts API endpoints
   - CLI agents call APIs (no direct database access)
   - Enables independent scaling and deployment

2. **PostgreSQL over CSV**: Migrated from CSV to database for:

   - Better concurrency and performance
   - ACID transactions
   - Directus compatibility
   - Proper indexing and relationships

3. **Multi-Agent System**: Each agent has single responsibility:

   - Mill = User interface & routing
   - Dev = Automated data collection
   - Param = Data analysis
   - Chatur = Decision support
   - Sera = Product discovery

4. **Message Bus Communication**: Agents coordinate via event-driven architecture
   - Loose coupling between agents
   - Async communication patterns
   - Scalable and maintainable

### Security

- **API Authentication**: Bearer token for service accounts
- **User Context**: Enforced ownership checks on all operations
- **Environment Variables**: Secrets never committed to repo
- **Input Validation**: All API endpoints validate inputs
- **Rate Limiting**: (Recommended for production)

## 📚 Documentation

### Complete Documentation Set

- **[API Documentation](./API_DOCUMENTATION.md)** - Complete REST API reference with examples
- **[Agent System Overview](./docs/agents/INDEX.md)** - Multi-agent architecture explained
- **[Mill Agent](./docs/agents/MILL_AGENT.md)** - Financial sidekick (chatbot)
- **[Dev Agent](./docs/agents/DEV_AGENT.md)** - SMS transaction parser
- **[Param Agent](./docs/agents/PARAM_AGENT.md)** - Financial analyst
- **[Chatur Agent](./docs/agents/CHATUR_AGENT.md)** - Financial coach
- **[Sera Agent](./docs/agents/SERA_AGENT.md)** - Shopping assistant

Each agent doc includes:

- Character essence and personality
- Core capabilities and features
- Tools and integration details
- Interaction patterns with other agents
- Technical architecture
- Configuration and best practices
- Example conversations and use cases

## 🚧 Development

### Running Tests

```bash
# Type checking
npm run typecheck

# Linting
npm run lint

# Build validation
npm run build
```

### Debugging

```bash
# Enable verbose logging
# Set environment variable before running
DEBUG=* npm run dev

# Check API connectivity
curl http://localhost:3000/api/transactions

# Verify database connection
npx prisma studio --schema=./data/schema.prisma
```

### Adding New Agents

1. Create agent definition in `src/agents/`
2. Implement runtime logic in `src/runtime/<agent>/`
3. Register in conversation router
4. Add tools in `src/tools/`
5. Update documentation in `docs/agents/`

See [Agent System Overview](./docs/agents/INDEX.md) for detailed guide.

## 🐛 Troubleshooting

### Common Issues

**Issue**: "Cannot connect to database"

- **Fix**: Check DATABASE_URL in .env
- **Fix**: Ensure PostgreSQL is running and accessible
- **Fix**: Verify network/firewall settings

**Issue**: "Gemini API quota exceeded"

- **Fix**: Check API key validity
- **Fix**: Monitor usage at ai.google.dev
- **Fix**: Implement rate limiting

**Issue**: "Tool execution failed"

- **Fix**: Check API authentication (SERVICE_API_TOKEN)
- **Fix**: Verify WEB_API_URL is correct
- **Fix**: Ensure web server is running

**Issue**: "SMS not processing"

- **Fix**: Check CRON_SECRET matches in request header
- **Fix**: Verify SMS format matches expected patterns
- **Fix**: Check Dev agent system prompt for supported banks

## 🎓 Built For

**MumbaiHacks 2025 - Fintech Problem Statement 1**  
Financial assistance system for gig workers with irregular income patterns.

**Key Requirements Met**:

- ✅ Conversational transaction logging
- ✅ SMS integration for automation
- ✅ Pattern detection for irregular income
- ✅ Personalized financial coaching
- ✅ Multi-agent coordination
- ✅ Real-time insights and advice

## 📝 License

MIT

## 👥 Contributors

- **Captain-Vikram** - Project Lead & Development

## 🙏 Acknowledgments

- Google Gemini for AI capabilities
- SerpAPI for product search
- Vercel for AI SDK and hosting
- Prisma for database management
- MumbaiHacks 2025 organizers

## 📞 Support

For issues, questions, or contributions:

1. Check documentation in `docs/` folder
2. Review API documentation
3. Check individual agent docs
4. Open an issue on GitHub

---

**Built with:** TypeScript • Next.js • PostgreSQL • Prisma • Google Gemini • Vercel AI SDK • SerpAPI

**Status**: ✅ Production Ready  
**Version**: 1.0.0  
**Last Updated**: November 14, 2025
