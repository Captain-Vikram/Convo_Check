# Convo Check - Multi-Agent Financial Tracking System

AI-powered financial assistant for gig workers featuring a multi-agent architecture with conversational transaction logging, automated habit analysis, and personalized financial coaching.

> **AWS Bedrock Compatible** 🚀  
> This branch supports both **AWS Bedrock (Claude 3.5)** and **Google Gemini** with simplified configuration. Switch providers with a single environment variable!

## 🎯 Overview

Convo Check is a comprehensive financial tracking system built for **MumbaiHacks 2025** (Fintech PS1) that helps gig workers manage irregular income through intelligent SMS integration and conversational AI.

### Multi-Agent Architecture

1. **Mill (Conversational Agent)** - Friendly chatbot for logging transactions and querying financial data
2. **Dev (Transaction Monitor)** - Monitors CSV changes, detects duplicates, manages transaction pipeline
3. **Param (Analyst Agent)** - Analyzes spending patterns and generates habit insights
4. **Chatur (Coach Agent)** - Delivers personalized financial guidance based on user habits

## 🚀 Features

- ✅ **Conversational Transaction Logging** - Natural language expense/income tracking
- ✅ **SMS Integration** - Automatic transaction ingestion from bank SMS
- ✅ **Duplicate Detection** - Auto-suppression of duplicate transactions within 2-minute windows
- ✅ **Habit Analysis** - AI-powered spending pattern recognition
- ✅ **Financial Coaching** - Context-aware guidance for gig workers
- ✅ **Multi-Agent Coordination** - Agents communicate and share insights seamlessly

## 📋 Prerequisites

- Node.js 20+
- npm 10+
- **Choose ONE:**
  - **AWS Bedrock** access (recommended - Claude 3.5 Sonnet/Haiku)
  - **Google Gemini** API key (alternative provider)

## 🛠️ Quick Setup (2 Minutes)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment (choose ONE provider)
cp .env.example .env
```

**Option A: AWS Bedrock (Recommended)**
```env
AI_PROVIDER=bedrock
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-1
```

**Option B: Google Gemini**
```env
AI_PROVIDER=google
GOOGLE_API_KEY=your_api_key
```

```bash
# 3. Verify setup
npm run typecheck
npm run build
```

📖 **Detailed Setup Guide:** See [docs/QUICK_START.md](docs/QUICK_START.md)

## 🎮 Usage

### Start Interactive Chat (Mill)

```bash
npx agent-cli chat
# or
npm run dev
```

**What happens on startup:**

- Dev Agent monitors `data/transactions.csv` for external changes
- Param (Analyst) analyzes transaction patterns
- Coach (Chatur) generates fresh financial guidance
- Mill is ready for conversation!

**Example commands:**

```
you> I spent 250 on groceries
you> show me my last 3 transactions
you> give me financial tips
you> what can you do
```

### Run Analyst Manually (Param)

```bash
npm run analyst
```

Generates habit insights in `data/habits.csv` and triggers Coach briefing.

### Start SMS Webhook Server

```bash
npm run sms-server
```

Listens on `http://localhost:7070/sms` for bank SMS transactions.

**Test with dummy SMS:**

```powershell
Invoke-RestMethod -Uri http://localhost:7070/sms -Method Post -ContentType 'application/json' -Body '{
  "messages": [{
    "sender": "JK-BOBSMS-S",
    "message": "Rs.250.00 Cr. to your A/C XXXXXX3080 via UPI from paytm@upi. Ref:991124333201.",
    "timestamp": "1760039290000",
    "date": "2025-10-12",
    "time": "15:28:10",
    "category": "Financial - High Confidence",
    "amount": "250.0",
    "type": "credit",
    "targetParty": "paytm@upi"
  }]
}'
```

### Other Commands

```bash
npm run build      # Compile TypeScript to dist/
npm run typecheck  # Validate TypeScript without emitting
npm run lint       # Check code quality
npx agent-cli describe mill     # View agent details
npx agent-cli check             # Validate environment setup
```

## 📁 Project Structure

```
src/
├── agents/           # Agent definitions (Mill, Dev, Param, Coach)
├── runtime/          # Agent execution logic
│   ├── chatbot-session.ts      # Mill conversation loop
│   ├── dev-agent.ts            # Transaction monitoring & duplicate detection
│   ├── analyst-agent.ts        # Habit pattern analysis (Param)
│   └── coach-agent.ts          # Financial guidance generation (Chatur)
├── tools/            # AI SDK tools (logging, querying)
├── server/           # SMS webhook server
└── config.ts         # Environment and agent configuration

data/
├── transactions.csv          # All logged transactions (Dev writes, all read)
├── habits.csv               # Param's habit insights
├── coach-briefings.json     # Chatur's guidance history
├── habit-snapshots/         # Snapshots for delta detection
└── sms-ingest-log.csv      # Raw SMS ingestion log
```

## 🤖 Agent Interaction Flow

1. **User asks Mill**: "show me my spending"
2. **Mill calls** `query_spending_summary` tool
3. **Tool coordinates**:
   - Triggers **Param** to refresh analysis from `transactions.csv`
   - Loads insights from **Param's** `habits.csv`
   - Retrieves advice from **Coach's** `coach-briefings.json`
   - Reads transaction data from **Dev's** `transactions.csv`
4. **Mill presents** unified response with totals, categories, insights, and coaching tips

## 🔧 Configuration

### Dual-Provider Support

This system supports **both AWS Bedrock and Google Gemini** with automatic model selection:

**AWS Bedrock (Default Models):**
- **Mill (Chatbot)**: Claude 3.5 Sonnet - Best for conversational quality
- **Dev (Accountant)**: Claude 3.5 Haiku - Fast transaction parsing
- **Param (Analyst)**: Claude 3.5 Sonnet - Deep pattern analysis
- **Chatur (Coach)**: Claude 3.5 Sonnet - Personalized guidance

**Google Gemini (Default Models):**
- **All Agents**: Gemini 1.5 Flash - Fast and efficient

### Environment Variables

**Minimal Setup (Single API Key):**
```env
# AWS Bedrock
AI_PROVIDER=bedrock
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx
AWS_REGION=us-east-1

# OR Google Gemini
AI_PROVIDER=google
GOOGLE_API_KEY=xxx
```

**Advanced: Custom Models (Optional)**
```env
AI_MODEL=anthropic.claude-3-5-sonnet-20241022-v2:0  # Override all agents
# OR per-agent:
CHATBOT_MODEL=custom-model-id
ACCOUNTANT_MODEL=custom-model-id
ANALYST_MODEL=custom-model-id
COACH_MODEL=custom-model-id
```

📖 **Full Migration Guide:** See [docs/MIGRATION_AWS_BEDROCK.md](docs/MIGRATION_AWS_BEDROCK.md)

## 📊 Data Flow

```
SMS Server → sms-ingest-log.csv → Dev Agent → transactions.csv
                                               ↓
                                    Param Agent → habits.csv
                                                  ↓
                                       Coach Agent → coach-briefings.json
                                                     ↓
                                          Mill ← query_spending_summary
```

## 🔄 What's New in AWS Bedrock Branch

- ✅ **Dual-Provider Architecture** - Switch between AWS Bedrock and Google Gemini instantly
- ✅ **Simplified Configuration** - Single API key per provider (no per-agent keys)
- ✅ **Smart Model Defaults** - Automatic role-based model selection
- ✅ **Type-Safe Implementation** - Unified `createLanguageModel()` helper
- ✅ **Claude 3.5 Support** - Access to latest Anthropic models via Bedrock
- ✅ **Zero Breaking Changes** - Backward compatible with existing Google setup

### Key Changes

- **Before:** Required 4 separate API keys (one per agent)
- **After:** Single `GOOGLE_API_KEY` or AWS credentials
- **Before:** Manual model configuration for each agent
- **After:** Smart defaults based on agent role (conversational vs analytical)
- **Migration Time:** ~2 minutes (see Quick Start guide)

## 🎓 Built For

**MumbaiHacks 2025 - Fintech Problem Statement 1**  
Financial assistance system for gig workers with irregular income patterns.

## 📚 Documentation

- [Quick Start Guide](docs/QUICK_START.md) - 2-minute setup
- [AWS Bedrock Migration](docs/MIGRATION_AWS_BEDROCK.md) - Comprehensive guide
- [Agent Tools Reference](docs/AGENT_TOOLS_REFERENCE.md) - Available functions
- [Financial Calculator](docs/FINANCIAL_CALCULATOR.md) - Built-in tools

## 📝 License

MIT

## 👥 Team

- Captain-Vikram (GitHub)

---

**Built with:** TypeScript, Vercel AI SDK, AWS Bedrock (Claude 3.5), Google Gemini, Node.js
