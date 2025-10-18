# Convo Check - Multi-Agent Financial Tracking System

AI-powered financial assistant for gig workers featuring a multi-agent architecture with conversational transaction logging, automated habit analysis, and personalized financial coaching.

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
- Google Gemini API key (for LLM agents)

## 🛠️ Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Add your Google Gemini API key to .env:
# GOOGLE_GENERATIVE_AI_API_KEY=your_key_here

# TypeScript check
npm run typecheck
```

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

All agents use Google Gemini models configured in `.env`:

```env
GOOGLE_GENERATIVE_AI_API_KEY=your_key_here
AGENT1_MODEL=gemini-1.5-flash    # Mill (Conversational)
AGENT2_MODEL=gemini-1.5-flash    # Dev (Monitor)
AGENT3_MODEL=gemini-1.5-flash    # Param (Analyst)
AGENT4_MODEL=gemini-1.5-flash    # Chatur (Coach)
```

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

## 🎓 Built For

**MumbaiHacks 2025 - Fintech Problem Statement 1**  
Financial assistance system for gig workers with irregular income patterns.

## 📝 License

MIT

## 👥 Team

- Captain-Vikram (GitHub)

---

**Built with:** TypeScript, Vercel AI SDK, Google Gemini, Node.js
