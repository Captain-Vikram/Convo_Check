# Import Path Fixes After Runtime Restructuring

## Current Structure

```
src/
├── agents/           (agents definitions)
├── config.ts         (agent config)
├── tools/            (shared tools)
├── runtime/
│   ├── mill/         (chatbot files)
│   ├── dev/          (SMS processing)
│   ├── param/        (analyst/habits)
│   ├── chatur/       (coach)
│   └── shared/       (common utilities)
│       ├── categorize.ts
│       ├── error-handling.ts
│       ├── transaction-normalizer.ts
│       └── ...
```

## Files That Moved to shared/

- `categorize.ts` → `shared/categorize.ts`
- `error-handling.ts` → `shared/error-handling.ts`
- `transaction-normalizer.ts` → `shared/transaction-normalizer.ts`
- `dev-agent.ts` → STAYED IN `dev/dev-agent.ts`
- `analyst-agent.ts` → MOVED TO `param/analyst-agent.ts`
- `coach-agent.ts` → MOVED TO `chatur/coach-agent.ts`

## Import Fixes Needed

### 1. src/index.ts

**Error:** Cannot find `'./runtime/chatbot-session.js'`
**Fix:** Change to `'./runtime/mill/chatbot-session.js'`

### 2. src/runtime/chatur/coach-agent.ts

**Errors:**

- `'../agents/coach.js'` ✅ OK
- `'../config.js'` → `'../../config.js'`
- `'./analyst-agent.js'` → `'../param/analyst-agent.js'`

### 3. src/runtime/chatur/conversational-coach.ts

**Errors:**

- `'../agents/coach.js'` ✅ OK
- `'../config.js'` → `'../../config.js'`
- `'./analyst-agent.js'` → `'../param/analyst-agent.js'`
- `'./error-handling.js'` → `'../shared/error-handling.js'`

### 4. src/runtime/dev/dev-agent.ts

**Errors:**

- `'../tools/log-cash-transaction.js'` → `'../../tools/log-cash-transaction.js'`
- `'./categorize.js'` → `'../shared/categorize.js'`

### 5. src/runtime/dev/dev-llm-parser.ts

**Errors:**

- `'../agents/dev.js'` → `'../../agents/dev.js'`
- `'../config.js'` → `'../../config.js'`

### 6. src/runtime/dev/dev-sms-agent.ts

**Errors:**

- `'../tools/log-cash-transaction.js'` → `'../../tools/log-cash-transaction.js'`
- `'./categorize.js'` → `'../shared/categorize.js'` (2 occurrences)

### 7. src/runtime/dev/transaction-normalizer.ts

**Errors:**

- `'../tools/log-cash-transaction.js'` → `'../../tools/log-cash-transaction.js'`
- `'./categorize.js'` → `'../shared/categorize.js'`

### 8. src/runtime/mill/chatbot-session.ts (32 errors!)

**Errors:**

- `'../config.js'` → `'../../config.js'`
- `'../agents/chatbot.js'` → `'../../agents/chatbot.js'`
- `'./categorize.js'` → `'../shared/categorize.js'` (2 occurrences)
- `'../tools/log-cash-transaction.js'` → `'../../tools/log-cash-transaction.js'`
- `'./dev-agent.js'` → `'../dev/dev-agent.js'`
- `'./transaction-normalizer.js'` → `'../shared/transaction-normalizer.js'`
- `'./coach-agent.js'` → `'../chatur/coach-agent.js'`
- `'./analyst-agent.js'` → `'../param/analyst-agent.js'`
- `'./transactions-loader.js'` → `'../param/transactions-loader.js'`

### 9. src/runtime/mill/conversational-mill.ts

**Errors:**

- `'../agents/chatbot.js'` → `'../../agents/chatbot.js'`
- `'../config.js'` → `'../../config.js'`
- `'./error-handling.js'` → `'../shared/error-handling.js'`
- `'../tools/log-cash-transaction.js'` → `'../../tools/log-cash-transaction.js'`
- `'../tools/query-spending-summary.js'` → `'../../tools/query-spending-summary.js'`

### 10. src/runtime/param/analyst-agent.ts

**Errors:**

- `'../agents/analyst.js'` → `'../../agents/analyst.js'`
- `'../config.js'` → `'../../config.js'`
- `'./transaction-normalizer.js'` → `'../shared/transaction-normalizer.js'`
- `'./coach-agent.js'` → `'../chatur/coach-agent.js'`

### 11. src/runtime/param/transactions-loader.ts

**Errors:**

- `'./transaction-normalizer.js'` → `'../shared/transaction-normalizer.js'`

### 12. src/runtime/shared/accountant.ts

**Errors:**

- `'./dev-agent.js'` → `'../dev/dev-agent.js'`

### 13. src/runtime/shared/agent-orchestrator.ts

**Errors:**

- `'../config.js'` → `'../../config.js'`

### 14. src/runtime/shared/conversation-router.ts

**Errors:**

- `'./conversational-mill.js'` → `'../mill/conversational-mill.js'`
- `'./conversational-coach.js'` → `'../chatur/conversational-coach.js'`
- `'./analyst-agent.js'` → `'../param/analyst-agent.js'`
- `'../tools/log-cash-transaction.js'` → `'../../tools/log-cash-transaction.js'`
- `'../tools/query-spending-summary.js'` → `'../../tools/query-spending-summary.js'`

### 15. src/server/sms-webhook.ts

**Errors:**

- `'../runtime/dev-agent.js'` → `'../runtime/dev/dev-agent.js'`
- `'../runtime/dev-sms-agent.js'` → `'../runtime/dev/dev-sms-agent.js'`
- `'../runtime/sms-log.js'` → `'../runtime/dev/sms-log.js'`

## Summary

- **Total files to fix:** 15 files
- **Total import paths to update:** ~70 imports
- **Pattern:** Most need to go up one more level (`..` → `../..`) or navigate through folders (`./` → `../folder/`)
