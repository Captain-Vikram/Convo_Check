# API Documentation

## Base URL

```
Production: https://your-domain.com
Development: http://localhost:3000
```

## Authentication

All API endpoints require authentication via Bearer token:

```
Authorization: Bearer <SERVICE_API_TOKEN>
```

Service accounts must include `owner` parameter in requests.

---

## 1. Transactions API

### GET /api/transactions

Fetch user transactions with pagination and filtering.

**Query Parameters:**

- `owner` (number, required for services) - User ID
- `limit` (number, default: 25, max: 100) - Items per page
- `cursor` (string) - Pagination cursor
- `startDate` (ISO date) - Filter by start date
- `endDate` (ISO date) - Filter by end date
- `type` (string) - Filter by type: `credit|debit|refund|other`

**Response:**

```json
{
  "transactions": [
    {
      "id": "uuid",
      "owner": 2,
      "amount": 1000.5,
      "type": "debit",
      "targetParty": "Merchant Name",
      "currency": "INR",
      "medium": "UPI",
      "description": "Payment description",
      "category": "Food",
      "dateOfTransaction": "2025-11-14T10:30:00Z",
      "dateCreated": "2025-11-14T10:30:00Z"
    }
  ],
  "nextCursor": "uuid",
  "hasMore": true
}
```

### POST /api/transactions

Create a new transaction.

**Body:**

```json
{
  "owner": 2,
  "amount": 1000.5,
  "type": "debit",
  "targetParty": "Merchant Name",
  "currency": "INR",
  "medium": "UPI",
  "description": "Payment description",
  "category": "Food",
  "dateOfTransaction": "2025-11-14T10:30:00Z",
  "originalSmsId": 123
}
```

**Response:**

```json
{
  "transaction": {
    /* full transaction object */
  },
  "id": "uuid"
}
```

---

## 2. Alerts API

### GET /api/alerts

Fetch financial alerts for a user.

**Query Parameters:**

- `owner` (number, required for services) - User ID
- `limit` (number, default: 50, max: 100)
- `cursor` (string) - Pagination cursor
- `type` (string) - Filter: `budget|anomaly|threshold|pattern`
- `severity` (string) - Filter: `low|medium|high|critical`
- `status` (string) - Filter: `open|acknowledged|resolved`
- `startDate` (ISO date) - Filter by creation date
- `endDate` (ISO date) - Filter by creation date

**Response:**

```json
{
  "alerts": [
    {
      "id": 1,
      "owner": 2,
      "alertType": "threshold",
      "severity": "high",
      "alertStatus": "open",
      "message": "Monthly spending exceeded budget",
      "confidence": 0.95,
      "thresholdValue": 50000,
      "actualValue": 55000,
      "deviationPercentage": 10.0,
      "category": "Shopping",
      "merchant": "Amazon",
      "transactionId": "uuid",
      "dateCreated": "2025-11-14T10:30:00Z",
      "acknowledgedAt": null
    }
  ],
  "nextCursor": "cursor-string",
  "hasMore": false
}
```

### POST /api/alerts

Create a new alert.

**Body:**

```json
{
  "owner": 2,
  "alertType": "threshold",
  "severity": "high",
  "message": "Budget exceeded",
  "ruleId": "monthly_budget_check",
  "transactionId": "uuid",
  "confidence": 0.95,
  "thresholdValue": 50000,
  "actualValue": 55000,
  "category": "Shopping"
}
```

### PATCH /api/alerts/[id]

Update an alert (e.g., acknowledge, resolve).

**Body:**

```json
{
  "alertStatus": "acknowledged",
  "acknowledgedBy": "User Name"
}
```

---

## 3. Habits API

### GET /api/habits

Fetch financial habit insights.

**Query Parameters:**

- `owner` (number, required for services) - User ID
- `limit` (number, default: 50, max: 100)
  Content-Type: application/json
- `cursor` (string) - Pagination cursor

**Response:**

```json
{
  "habits": [
    {
  "attachments": [
    {
      "type": "image",
      "mimeType": "image/png",
      "data": "<base64 screenshot>"
    }
  ]
      "evidence": "Savings rate 0.49 last 30 days",
      "counsel": "Continue this strong practice",
      "fullText": "Proactive Saving: Evidence...",
      "metrics": {
        /* JSON object */
- `attachments` _(array, optional)_ – List of images or audio clips in the [`AgentAttachment`](../src/runtime/shared/multimodal.ts) shape. Include either a `data` URI/base64 payload or a remotely hosted `url`.
- `options` _(object, optional)_ – Reserved for server-side adapters (actual callbacks are functions). When calling over HTTP you should omit this property.
      "recordedAt": "2025-11-14T10:30:00Z",
      "transactionId": "uuid"
    }
  ],
  "nextCursor": "cursor",
  "hasMore": false
}
```

### POST /api/habits

Create a new habit insight.

**Body:**

```json
{
  "owner": 2,
  "habitId": "unique-hash",
  "habitLabel": "Impulse Buying",
  "evidence": "3 unplanned purchases this week",
  "counsel": "Implement 24-hour rule",
  "fullText": "Impulse Buying: Evidence... Counsel...",
  "transactionId": "uuid",
  "metrics": {
    /* optional JSON */
  }
}
```

---

## 4. Habit Snapshots API

### GET /api/habit-snapshots

Fetch aggregated financial behavior snapshots.

**Query Parameters:**

- `owner` (number, required for services) - User ID
- `limit` (number, default: 20, max: 50)

**Response:**

```json
{
  "snapshots": [
    {
      "id": 1,
      "snapshotId": "hash",
      "owner": 2,
      "trigger": "transaction",
      "contextData": {
        "insights": [
          {
            "habitLabel": "Proactive Saving",
            "evidence": "...",
            "counsel": "..."
          }
        ],
        "generatedAt": "2025-11-14T10:30:00Z"
      },
      "summaryData": {
        "insightLabels": ["Proactive Saving", "Expense Focus"],
        "insightsCount": 6
      },
      "topCategories": [{ "category": "Food", "amount": 5000, "count": 15 }],
      "frequentMerchants": [
        { "merchant": "Swiggy", "amount": 3000, "count": 10 }
      ],
      "flags": { "overspending": false, "impulseBuying": true },
      "generatedAt": "2025-11-14T10:30:00Z"
    }
  ],
  "count": 1
}
```

---

## 5. Coach Briefings API

### GET /api/coach-briefings

Fetch personalized coaching advice.

**Query Parameters:**

- `owner` (number, required for services) - User ID
- `limit` (number, default: 50, max: 100)
- `delivered` (boolean) - Filter by delivery status
- `cursor` (string) - Pagination cursor

**Response:**

```json
{
  "briefings": [
    {
      "id": "uuid",
      "owner": 2,
      "headline": "Great savings progress!",
      "counsel": "You've saved 20% more this month...",
      "evidence": "Analysis of last 30 days...",
      "trigger": "monthly_review",
      "delivered": false,
      "deliveredAt": null,
      "snapshotId": 1,
      "dateCreated": "2025-11-14T10:30:00Z"
    }
  ],
  "nextCursor": "cursor",
  "hasMore": false
}
```

### POST /api/coach-briefings

Create a new coaching briefing.

**Body:**

```json
{
  "owner": 2,
  "headline": "Budget alert",
  "counsel": "Consider reducing dining out expenses",
  "evidence": "Spent 50% more on dining this month",
  "trigger": "threshold_breach",
  "snapshotId": 1
}
```

### PATCH /api/coach-briefings/[id]

Mark briefing as delivered.

**Body:**

```json
{
  "delivered": true
}
```

---

## 6. Wishlist API (NEW)

### GET /api/wishlist

Fetch user's product wishlist.

**Query Parameters:**

- `owner` (number, required for services) - User ID
- `limit` (number, default: 50, max: 100)
- `sortBy` (string) - `date_added|current_price|name`
- `order` (string) - `asc|desc`

**Response:**

```json
{
  "items": [
    {
      "id": "uuid",
      "owner": 2,
      "name": "Wireless Headphones",
      "link": "https://amazon.in/...",
      "currentPrice": "₹4,999",
      "desiredPrice": "₹3,500",
      "rating": "4.5/5",
      "source": "Amazon.in",
      "dateAdded": "2025-11-14T10:30:00Z",
      "createdAt": "2025-11-14T10:30:00Z",
      "updatedAt": "2025-11-14T10:30:00Z"
    }
  ],
  "count": 1,
  "owner": 2
}
```

### POST /api/wishlist

Add item to wishlist.

**Body:**

```json
{
  "owner": 2,
  "name": "Product Name",
  "link": "https://store.com/product",
  "currentPrice": "₹4,999",
  "desiredPrice": "₹3,500",
  "rating": "4.5/5",
  "source": "Amazon.in"
}
```

**Response:**

```json
{
  "success": true,
  "item": {
    /* full item object */
  }
}
```

### GET /api/wishlist/[id]

Get a single wishlist item.

**Response:**

```json
{
  "id": "uuid",
  "owner": 2,
  "name": "Product Name",
  "link": "https://...",
  "currentPrice": "₹4,999",
  "desiredPrice": "₹3,500",
  "rating": "4.5/5",
  "source": "Amazon.in",
  "dateAdded": "2025-11-14T10:30:00Z",
  "createdAt": "2025-11-14T10:30:00Z",
  "updatedAt": "2025-11-14T10:30:00Z"
}
```

### PATCH /api/wishlist/[id]

Update wishlist item.

**Body (all optional):**

```json
{
  "name": "Updated Name",
  "currentPrice": "₹4,299",
  "desiredPrice": "₹3,000",
  "rating": "4.7/5"
}
```

**Response:**

```json
{
  "success": true,
  "item": {
    /* updated item */
  }
}
```

### DELETE /api/wishlist/[id]

Remove item from wishlist.

**Response:**

```json
{
  "success": true,
  "message": "Wishlist item removed",
  "deletedItem": {
    "id": "uuid",
    "name": "Product Name"
  }
}
```

### DELETE /api/wishlist

Clear all wishlist items for a user.

**Query Parameters:**

- `owner` (number, required for services) - User ID

**Response:**

```json
{
  "success": true,
  "deletedCount": 5,
  "message": "Cleared 5 items from wishlist"
}
```

---

## 7. SMS Processing API

### POST /api/sms/process-queue

Process queued SMS messages (cron job endpoint).

**Headers:**

```
x-cron-secret: <CRON_SECRET>
```

**Response:**

```json
{
  "processed": 10,
  "errors": 0,
  "message": "Processed 10 SMS messages"
}
```

---

## 8. Agent Conversation API (NEW)

### POST /api/agent

Single entry point that exposes the entire agentic system (Mill + router + supporting agents) directly through the web server. Every request automatically reuses the user’s context window, so Mill can maintain full conversational state.

**Headers:**

```
Authorization: Bearer <SERVICE_API_TOKEN>
Content-Type: application/json
```

**Body:**

```json
{
  "userId": "phone-or-user-key",
  "message": "What did I spend yesterday?",
  "options": {
    "onTransactionReady": true,
    "onQueryReady": true
  }
}
```

- `userId` _(string, required)_ – Stable identifier per end user (phone hash/UUID). Determines which context window to load.
- `message` _(string, required)_ – User’s utterance. The router infers intent and selects Mill/Chatur/Sera automatically.
- `options` _(object, optional)_ – Pass-through flags for router hooks (e.g., enable transaction logging callbacks). Leave empty for default behavior.

**Response:**

```json
{
  "agent": "mill",
  "message": "You spent ₹2,350 yesterday across 3 transactions.",
  "completed": false,
  "switched": false,
  "sessionId": "a6b5...",
  "context": {
    "activeAgent": "mill",
    "conversationHistory": [
      { "agent": "mill", "userMessage": "Hi", "agentResponse": "Hello!" }
    ]
  }
}
```

- `agent` – Which specialist responded (Mill/Chatur/Sera).
- `message` – Text to return to the user.
- `completed` – True when the agent finished an action (e.g., logging or escalation).
- `switched`/`newAgent` – Present when router hands the conversation to another agent.
- `sessionId` – Underlying Mill/agent session (useful for debugging).
- `context` – Snapshot of the conversation window (active agent, history) as maintained in-memory.

**Context window behavior:**

- Each `userId` maps to its own `ConversationContext` and agent session, so subsequent POSTs automatically include prior turns.
- Sessions live in memory by default and can persist via Redis by setting `REDIS_URL`/`UPSTASH_REDIS_URL` (see `web/src/lib/mill/conversation-store.ts`). That way `/api/agent` keeps history even when the Next.js server restarts.
- Router automatically escalates to Chatur/Sera based on message content—no extra APIs required.

**Typical uses:**

- WhatsApp/SMS/webchat webhook handlers.
- Internal dashboards needing “chat with Mill” features.
- Programmatic workflows that want to reuse Mill’s orchestration logic without running the CLI.

---

## Error Responses

All endpoints return standard error format:

```json
{
  "error": "Error message description"
}
```

**HTTP Status Codes:**

- `200` - Success
- `201` - Created
- `400` - Bad Request (invalid parameters)
- `401` - Unauthorized (missing/invalid token)
- `403` - Forbidden (no permission)
- `404` - Not Found
- `500` - Internal Server Error

---

## Environment Variables

### Required:

```bash
DATABASE_URL=postgresql://user:pass@host:port/db
JWT_SECRET=your-jwt-secret
SERVICE_API_TOKEN=your-service-token
DEV_USER_ID=2
```

### Optional:

```bash
WEB_API_URL=http://localhost:3000  # For API client
API_KEY=optional-api-key           # For additional auth
DISABLE_AUTH=0                     # Set to 1 for local dev
CRON_SECRET=your-cron-secret       # For SMS processing
```

### AI Agents:

```bash
CHATBOT_GEMINI_API_KEY=your-key
ACCOUNTANT_GEMINI_API_KEY=your-key
ANALYST_GEMINI_API_KEY=your-key
COACH_GEMINI_API_KEY=your-key
SERA_GEMINI_API_KEY=your-key
SERPAPI_KEY=your-serpapi-key
```

---

## Rate Limiting

Currently no rate limiting implemented. Recommended to add:

- 100 requests/minute per user
- 1000 requests/minute per service account

---

## Pagination

All list endpoints support cursor-based pagination:

1. First request returns `nextCursor` if more data exists
2. Include `cursor` parameter in next request
3. `hasMore: false` indicates end of results

---

## Database Schema

PostgreSQL with Prisma ORM. Key tables:

- `tranasctions` - Financial transactions
- `alerts` - Financial alerts
- `habit_insights` - Individual habit patterns
- `habit_snapshots` - Aggregated behavior snapshots
- `coach_briefings` - Coaching advice
- `shopping_wishlist` - Product wishlist (NEW)
- `sms_messages` - SMS transaction data
- `users` - User accounts

Directus-compatible:

- snake_case field names
- UUID primary keys
- timestamptz columns
- Proper indexing

---

## Client Libraries

### Wishlist API Client (JavaScript/TypeScript)

```typescript
import { createWishlistApiClient } from "./wishlist-api-client";

const client = createWishlistApiClient({
  baseUrl: "http://localhost:3000",
  apiKey: process.env.API_KEY,
  userId: 2,
});

// Add item
const item = await client.addToWishlist({
  name: "Product",
  link: "https://...",
  currentPrice: "₹999",
  desiredPrice: "₹799",
  source: "Amazon",
});

// Get wishlist
const { items } = await client.getWishlist();

// Update item
await client.updateWishlistItem(id, {
  currentPrice: "₹899",
});

// Remove item
await client.removeWishlistItem(id);
```

---

## Deployment

### Development:

```bash
npm install
npm run build
npm run dev  # Starts Next.js on port 3000
```

### Production:

```bash
npm run build
npm start
```

### Vercel:

- Configure environment variables in Vercel dashboard
- Push to main branch (auto-deploys)
- DATABASE_URL must point to production Postgres

---

## Security Notes

1. **Never commit `.env` file** - Already in `.gitignore`
2. **Rotate API keys regularly** - Especially Gemini keys
3. **Use strong JWT_SECRET** - For token signing
4. **Enable HTTPS** - In production
5. **Validate all inputs** - API does basic validation
6. **Monitor rate limits** - Add if public-facing
7. **Backup database** - Regular automated backups

---

## Support

For issues or questions:

- Check logs in `console.log` / terminal output
- Verify environment variables are set
- Ensure database is accessible
- Check Prisma client is generated: `npx prisma generate --schema=./data/schema.prisma`

---

**Last Updated**: November 14, 2025
**Version**: 1.0.0
