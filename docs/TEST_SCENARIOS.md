# Interactive Test Scenarios for Convo Check

**Manual Testing Guide for Chatbot and Multi-Agent System**  
**Date:** October 18, 2025

---

## 📋 Quick Start

### Prerequisites

1. Ensure `.env` file is configured with API keys
2. Start SMS webhook server: `npm run sms-server`
3. Start chatbot: `npx agent-cli chat`
4. Have Postman or curl ready for API tests

---

## 🧪 Test Scenarios

### SCENARIO 1: Basic Chatbot Interaction (5 minutes)

**Objective:** Verify Mill responds correctly to greetings and instructions

**Steps:**

1. Start chatbot: `npx agent-cli chat`
2. Type: `hello`

   - **Expected:** Mill greets you with personality
   - **Pass Criteria:** Response mentions Mill's name or capabilities

3. Type: `what can you do?`

   - **Expected:** Mill lists both logging AND querying capabilities
   - **Pass Criteria:** Mentions "log transactions" AND "fetch spending data"

4. Type: `help me track my money`
   - **Expected:** Encouraging response with guidance
   - **Pass Criteria:** Friendly tone, mentions tracking features

**Screenshot:** Take screenshot of conversation

---

### SCENARIO 2: Expense Logging (English) (10 minutes)

**Objective:** Test Mill's ability to log expenses via natural language

**Test Cases:**

#### 2.1 Simple Expense

```
Input: I spent INR 250 on groceries
Expected:
  - Confirmation message ("Got it", "Logged", etc.)
  - Category inferred (Food & Groceries)
  - Upbeat tone ("Nice one!", emojis)
Pass Criteria: Transaction logged to data/transactions.csv
```

#### 2.2 Different Format

```
Input: paid 100 rupees for cab today
Expected:
  - Transaction logged
  - Category: Transportation
  - Date: Today's date
Pass Criteria: data/transactions.csv shows new entry with amount 100
```

#### 2.3 With Rupee Symbol

```
Input: bought ₹500 worth of books
Expected:
  - Amount: 500
  - Category: Shopping or Education
Pass Criteria: Transaction appears in CSV
```

#### 2.4 Decimal Amount

```
Input: spent Rs. 99.50 on snacks
Expected:
  - Amount: 99.50 (precise decimal)
  - Category: Food
Pass Criteria: CSV shows 99.50, not 99 or 100
```

**Verification:**

- Open `data/transactions.csv`
- Count new entries (should be 4)
- Check amounts, categories, descriptions match

---

### SCENARIO 3: Income Logging (10 minutes)

**Objective:** Test income detection and logging

**Test Cases:**

#### 3.1 Client Payment

```
Input: received INR 5000 from client for freelance work
Expected:
  - Celebration message ("Deposit secured!", "Financial glow-up!")
  - Direction: income
  - Amount: 5000
Pass Criteria: CSV shows income entry
```

#### 3.2 Different Verbs

```
Input: earned 1500 for consulting
Expected: Logged as income
Pass Criteria: Direction = income in CSV
```

#### 3.3 Mixed Format

```
Input: got ₹2000 payment today
Expected: Income with today's date
Pass Criteria: CSV entry with direction=income
```

**Verification:**

- Check `data/transactions.csv`
- Filter for `direction = "income"`
- Verify 3 new income entries

---

### SCENARIO 4: Query Transactions (15 minutes) ⚠️ CRITICAL TEST

**Objective:** Verify Mill ACTUALLY calls query_spending_summary tool (not just text)

**Test Cases:**

#### 4.1 Summary Request

```
Input: show me my spending
Expected:
  - Mill calls query_spending_summary tool IMMEDIATELY
  - Displays actual data (transaction count, amounts)
  - Shows Param insights if available
  - Shows Coach advice if available
Pass Criteria:
  - Response contains NUMBERS (not "let me fetch")
  - Includes breakdown (expenses, income, net)
```

#### 4.2 Recent Transactions

```
Input: fetch my last 3 transactions
Expected:
  - Lists exactly 3 transactions
  - Shows date, amount, category, description
  - Newest first
Pass Criteria:
  - Response contains transaction details
  - NOT just "I'll fetch that for you"
```

#### 4.3 Alternative Phrasing

```
Input: give me what all spent
Expected: Full spending summary
Pass Criteria: Actual numbers displayed
```

#### 4.4 Transaction History

```
Input: show all expenses
Expected:
  - Total expense amount
  - List of expense transactions
Pass Criteria: Matches data/transactions.csv expense count
```

**Debugging:**
If Mill responds with text like "let me fetch that" but NO DATA:

- ❌ Tool NOT called (intent parser should catch this)
- Check chatbot-session.ts line ~209 for handleParsedIntent
- Verify intent-parser.ts patterns match input

**Success Indicators:**

- ✅ See actual transaction data in response
- ✅ Numbers match CSV file
- ✅ Param insights mentioned
- ✅ Coach advice shown

---

### SCENARIO 5: Duplicate Detection (10 minutes)

**Objective:** Test 2-minute duplicate window

**Test Cases:**

#### 5.1 Immediate Duplicate

```
Step 1: I spent INR 300 on dinner
Step 2: (wait 10 seconds)
Step 3: I spent INR 300 on dinner

Expected:
  - First: Logged successfully
  - Second: Suppressed OR prompts for confirmation
Pass Criteria:
  - Only 1 entry in CSV (or 1 with duplicate flag)
  - Message about duplicate detected
```

#### 5.2 Different Amount, Same Description

```
Step 1: I spent INR 50 on coffee
Step 2: I spent INR 100 on coffee

Expected:
  - Both logged (different amounts)
Pass Criteria: 2 separate CSV entries
```

#### 5.3 High-Value Duplicate

```
Step 1: paid 5000 for rent
Step 2: paid 5000 for rent

Expected:
  - Prompt to confirm ("Did you pay rent twice?")
Pass Criteria:
  - Dev agent flags as duplicate
  - User asked to confirm or ignore
```

**Verification:**

- Count entries in `data/transactions.csv`
- Check for duplicate suppression messages in terminal

---

### SCENARIO 6: Multi-Agent Coordination (20 minutes)

**Objective:** Verify Dev → Param → Coach pipeline

**Setup:**

1. Ensure you have at least 5-7 transactions logged
2. Wait for automatic Param run OR trigger manually

**Test Cases:**

#### 6.1 Param Analysis Trigger

```
Method 1 (Automatic):
  - Log 5+ transactions
  - Wait ~1 minute
  - Check data/habits.csv for new insights

Method 2 (Manual):
  - Run: npm run analyst
  - Check terminal output

Expected:
  - 6-7 habit insights generated
  - Saved to data/habits.csv
Pass Criteria:
  - habits.csv has new entries
  - Insights mention categories, percentages, patterns
```

#### 6.2 Coach Briefing Generation

```
After Param runs:
  - Check data/coach-briefings.json
  - Verify briefing has:
    - headline (string)
    - counsel (string)
    - timestamp

Expected:
  - Briefing references specific habits from Param
  - Actionable advice (not generic)
Pass Criteria:
  - JSON structure valid
  - Advice mentions actual spending patterns
```

#### 6.3 Full Pipeline in Chat

```
Input: analyze my expenses

Expected:
  - Mill triggers Param analysis
  - Param generates insights
  - Coach creates briefing
  - Mill returns unified response with:
    * Transaction summary
    * Param insights
    * Coach advice
Pass Criteria:
  - All 3 agent outputs visible in response
  - Response is coherent and unified
```

**Verification:**

- Terminal shows agent coordination logs
- Files updated: transactions.csv → habits.csv → coach-briefings.json
- Chat response includes insights + advice

---

### SCENARIO 7: SMS Webhook Integration (15 minutes)

**Objective:** Test external SMS ingestion

**Prerequisites:**

- SMS webhook server running (`npm run sms-server`)
- Port 7070 accessible

**Test Cases:**

#### 7.1 Valid Bank SMS

```bash
curl -X POST http://localhost:7070/sms \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-secret-here" \
  -d '{
    "sender": "JK-BOBSMS-S",
    "message": "Rs.150.00 Dr. from A/C XXXXXX3080 and Cr. to merchant@upi. Ref:123456. AvlBal:Rs500.00",
    "timestamp": 1697654400000
  }'

Expected Response:
{
  "summary": {
    "processed": 1,
    "duplicates": 0,
    "suppressed": 0,
    "skipped": 0
  },
  "results": [...]
}

Pass Criteria:
  - Status 200
  - Transaction in data/transactions.csv
  - Amount: 150, Direction: expense
```

#### 7.2 Credit (Income) SMS

```bash
curl -X POST http://localhost:7070/sms \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-secret-here" \
  -d '{
    "sender": "JK-BOBSMS-S",
    "message": "Rs.1000.00 Cr. to your A/C XXXXXX3080 via UPI from client@upi. Ref:789012.",
    "timestamp": 1697654410000
  }'

Expected:
  - processed: 1
  - Direction: income in CSV
Pass Criteria: Income transaction logged
```

#### 7.3 Duplicate SMS

```bash
# Send same message twice
curl -X POST http://localhost:7070/sms ... (same as 7.1)
# Wait 10 seconds
curl -X POST http://localhost:7070/sms ... (same as 7.1)

Expected:
  - First: processed: 1
  - Second: duplicates: 1 OR suppressed: 1
Pass Criteria: Only 1 transaction in CSV
```

#### 7.4 Invalid JSON

```bash
curl -X POST http://localhost:7070/sms \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-secret-here" \
  -d 'invalid-json'

Expected:
  - Status 400
  - Error: "Invalid JSON"
Pass Criteria: Graceful error, no crash
```

#### 7.5 Authentication Failure

```bash
curl -X POST http://localhost:7070/sms \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: wrong-secret" \
  -d '{"sender":"test","message":"test"}'

Expected:
  - Status 401 (if auth enabled)
  - Error: "Unauthorized"
Pass Criteria: Request blocked
```

#### 7.6 Rate Limiting

```bash
# Send 65 requests rapidly (in a loop)
for i in {1..65}; do
  curl -X POST http://localhost:7070/sms \
    -H "X-Webhook-Secret: your-secret-here" \
    -d "{\"sender\":\"test\",\"message\":\"msg$i\"}"
done

Expected:
  - First 60: Status 200
  - 61st onward: Status 429 (Too Many Requests)
Pass Criteria: Rate limiter enforced
```

#### 7.7 Health Check

```bash
curl http://localhost:7070/health

Expected:
{
  "status": "ok",
  "uptime": 123.45,
  "timestamp": "..."
}

Pass Criteria: Status 200, valid JSON
```

**Verification:**

- Check `data/sms-ingest-log.csv` for processing logs
- Count entries in `data/transactions.csv`
- Verify webhook server logs show processing

---

### SCENARIO 8: Edge Cases (15 minutes)

**Objective:** Test error handling and corner cases

**Test Cases:**

#### 8.1 Ambiguous Input

```
Input: I spent money on stuff
Expected:
  - Mill asks clarifying questions
  - "How much did you spend?"
  - "What was it for?"
Pass Criteria: Doesn't crash, asks for details
```

#### 8.2 Very Large Amount

```
Input: spent INR 100000 on laptop
Expected:
  - Logged successfully
  - No crash or error
Pass Criteria: CSV shows 100000
```

#### 8.3 Zero Amount

```
Input: I spent 0 rupees
Expected:
  - Either rejects or asks for clarification
Pass Criteria: Handles gracefully
```

#### 8.4 Negative Amount

```
Input: I spent -50 rupees
Expected:
  - Rejects or converts to positive
Pass Criteria: No crash
```

#### 8.5 Non-English Characters

```
Input: I spent ₹100 on चाय (tea)
Expected:
  - Logs transaction
  - Description: चाय or chai
Pass Criteria: Handles Unicode
```

#### 8.6 Empty Input

```
Input: (just press Enter)
Expected:
  - Prompt for input again
  - No crash
Pass Criteria: Graceful handling
```

#### 8.7 Very Long Description

```
Input: I spent INR 50 on a very very very very very long description that goes on and on and on for many words testing the limit of what the system can handle
Expected:
  - Either accepts or truncates
  - No crash
Pass Criteria: Handles gracefully
```

---

### SCENARIO 9: Multilingual Support (Hindi) (10 minutes)

**Objective:** Test Hindi/Hinglish input handling

**Test Cases:**

#### 9.1 Hindi Expense

```
Input: maine 100 rupaye kharch kiya chai par
Expected:
  - Detected as expense
  - Amount: 100
  - Description: chai par
Pass Criteria: Transaction logged
```

#### 9.2 Mixed Hindi-English

```
Input: kharch kiya 50 rupees on food
Expected:
  - Amount: 50
  - Description: food
Pass Criteria: Intent parser catches it
```

#### 9.3 Hindi Query

```
Input: mera kharcha dikhao
Expected:
  - Interpreted as "show spending"
  - Triggers query
Pass Criteria: Mill responds with data (if patterns support)
```

**Note:** Current implementation has LIMITED Hindi support. Document what works vs. what doesn't.

---

### SCENARIO 10: Performance & Stress Tests (15 minutes)

**Objective:** Test system under load

**Test Cases:**

#### 10.1 Many Transactions

```
Steps:
  1. Log 20 transactions via chat (use script)
  2. Verify all logged
  3. Query: "show all transactions"
  4. Measure response time

Expected:
  - All 20 in CSV
  - Query response < 5 seconds
Pass Criteria: No crashes, reasonable speed
```

#### 10.2 Large Habit Analysis

```
Steps:
  1. Ensure 50+ transactions in CSV
  2. Run: npm run analyst
  3. Check habits.csv generation time

Expected:
  - Completes in < 30 seconds
  - Generates 6-7 insights
Pass Criteria: No memory errors, insights coherent
```

#### 10.3 Concurrent SMS Requests

```bash
# Send 10 requests in parallel
for i in {1..10}; do
  curl -X POST http://localhost:7070/sms ... &
done
wait

Expected:
  - All processed successfully
  - No race conditions
Pass Criteria: All responses valid, CSV consistent
```

---

## 📊 Test Results Template

**Copy this for each testing session:**

```
Test Session: [Date/Time]
Tester: [Name]
Version: [Git commit hash]

SCENARIO 1 - Basic Interaction: [ ] PASS [ ] FAIL
  Notes: ___________________________________________

SCENARIO 2 - Expense Logging: [ ] PASS [ ] FAIL
  Test 2.1: [ ] PASS [ ] FAIL
  Test 2.2: [ ] PASS [ ] FAIL
  Test 2.3: [ ] PASS [ ] FAIL
  Test 2.4: [ ] PASS [ ] FAIL
  Notes: ___________________________________________

SCENARIO 3 - Income Logging: [ ] PASS [ ] FAIL
  Notes: ___________________________________________

SCENARIO 4 - Query Transactions: [ ] PASS [ ] FAIL ⚠️ CRITICAL
  Test 4.1: [ ] PASS [ ] FAIL
  Test 4.2: [ ] PASS [ ] FAIL
  Test 4.3: [ ] PASS [ ] FAIL
  Test 4.4: [ ] PASS [ ] FAIL
  Notes: ___________________________________________

SCENARIO 5 - Duplicate Detection: [ ] PASS [ ] FAIL
  Notes: ___________________________________________

SCENARIO 6 - Multi-Agent: [ ] PASS [ ] FAIL
  Dev → Param: [ ] PASS [ ] FAIL
  Param → Coach: [ ] PASS [ ] FAIL
  Full Pipeline: [ ] PASS [ ] FAIL
  Notes: ___________________________________________

SCENARIO 7 - SMS Webhook: [ ] PASS [ ] FAIL
  Test 7.1-7.7: ___/7 passed
  Notes: ___________________________________________

SCENARIO 8 - Edge Cases: [ ] PASS [ ] FAIL
  Notes: ___________________________________________

SCENARIO 9 - Hindi Support: [ ] PASS [ ] FAIL
  Notes: ___________________________________________

SCENARIO 10 - Performance: [ ] PASS [ ] FAIL
  Notes: ___________________________________________

OVERALL PASS RATE: ___/10 scenarios passed
CRITICAL ISSUES: ___________________________
RECOMMENDATIONS: ___________________________
```

---

## 🐛 Common Issues & Debugging

### Issue 1: Mill Doesn't Call query_spending_summary Tool

**Symptoms:**

- User says "show transactions"
- Mill responds "Let me fetch that for you" but shows NO DATA

**Debug Steps:**

1. Check `src/runtime/chatbot-session.ts` line ~209
2. Verify `handleParsedIntent` function exists and is called
3. Test intent parser directly:
   ```javascript
   import { parseUserIntent } from "./src/runtime/intent-parser.js";
   console.log(parseUserIntent("show my transactions"));
   // Should return: { querySummary: true }
   ```
4. Check if Gemini is calling tool (look for tool call logs)
5. Ensure intent parser fallback is active

**Fix:**

- Intent parser should catch this even if Gemini doesn't
- Verify patterns in `src/runtime/intent-parser.ts` match user input

---

### Issue 2: SMS Webhook Returns 401 on All Requests

**Symptoms:**

- Every POST to /sms fails with 401 Unauthorized

**Debug Steps:**

1. Check `.env` has `SMS_WEBHOOK_SECRET` set
2. Verify header in request: `-H "X-Webhook-Secret: <value>"`
3. Check if webhook code has authentication enabled

**Fix:**

- Set `SMS_WEBHOOK_SECRET` in `.env`
- Include header in all requests
- OR disable authentication for testing (not recommended for prod)

---

### Issue 3: Param Generates Placeholder Insights

**Symptoms:**

- `habits.csv` contains "Insufficient History" message

**Debug Steps:**

1. Count transactions: `wc -l data/transactions.csv`
2. Need minimum ~5 transactions for real insights

**Fix:**

- Log more transactions via chat or SMS
- Verify `data/transactions.csv` has data
- Re-run: `npm run analyst`

---

### Issue 4: Coach Briefing Empty or Generic

**Symptoms:**

- `coach-briefings.json` has generic advice

**Debug Steps:**

1. Check if Param has run first
2. Verify `data/habits.csv` has real insights
3. Check Coach prompt includes previous insights

**Fix:**

- Ensure Param → Coach handoff is working
- Check `src/runtime/analyst-agent.ts` calls `runCoach`
- Verify Coach reads `habits.csv` correctly

---

## 🎯 Success Criteria

**Minimum for Demo:**

- ✅ 8/10 scenarios pass
- ✅ SCENARIO 4 (Query Transactions) MUST PASS
- ✅ SCENARIO 6 (Multi-Agent) MUST PASS
- ✅ No critical crashes
- ✅ Duplicate detection working

**Ideal for Production:**

- ✅ 10/10 scenarios pass
- ✅ All edge cases handled
- ✅ Performance tests pass
- ✅ Security tests pass (webhook auth, rate limiting)

---

## 📸 Documentation

For each scenario:

1. Take screenshots of:

   - Chat conversations
   - CSV file contents
   - API responses
   - Terminal logs

2. Record videos of:

   - Full pipeline (SMS → Dev → Param → Coach)
   - Live demo scenario

3. Save to:
   - `test-results/screenshots/`
   - `test-results/videos/`

---

**Last Updated:** October 18, 2025  
**Version:** 1.0  
**Tested By:** [Your Name]
