# Stateful to Stateless Migration Guide

## Current State: MOSTLY STATEFUL ❌

The system has significant in-memory state that is **lost on server restart, deployment, or when scaling to multiple instances**.

---

## 📊 Stateful Components Analysis

### 1. **Conversation Storage** ⚠️ CONDITIONALLY STATELESS

**Current Implementation:**

- **With Redis**: Stateless (1-hour TTL, shared across instances)
- **Without Redis**: Stateful (in-memory Map, lost on restart)

**Location:** `web/src/lib/mill/conversation-store.ts`

```typescript
// STATEFUL (fallback)
class InMemoryConversationStore {
  private contexts = new Map<string, ConversationContext>();
}

// STATELESS (if REDIS_URL configured)
class RedisConversationStore {
  // Uses external Redis for storage
}
```

**What's Stored:**

- `activeAgent`: Which agent is handling the conversation (mill/chatur/sera)
- `millSessionId`, `chaturSessionId`, `seraSessionId`: Session identifiers
- `millSession`, `chaturSession`, `seraSession`: Full agent state
- `conversationHistory`: Complete chat transcript
- `updatedAt`: Last modified timestamp

**Impact of Loss:**

- Users lose conversation context
- Must restart conversation from scratch
- Cannot resume multi-turn interactions

---

### 2. **Agent Sessions** ❌ STATEFUL

**Location:** `web/src/runtime/shared/base-agent.ts`

```typescript
protected activeSessions = new Map<string, TSession>();
```

**Affects:**

- Mill (transaction logging agent)
- Chatur (coaching agent)
- Sera (shopping agent)

**What's Stored:**

- Session ID → Session state mapping
- Current conversation step
- Pending data (forms, queries, etc.)
- Agent-specific context

**Impact of Loss:**

- Users lose partial conversation progress
- Incomplete transactions get dropped
- Agent loses context mid-conversation

---

### 3. **Alert Manager Cache** ❌ STATEFUL

**Location:** `web/src/runtime/dev/alert-manager.ts`

```typescript
private readonly listeners = new Set<AlertListener>();
private readonly alertSignatureCache = new Map<string, {
  timestamp: number;
  count: number
}>();
```

**What's Stored:**

- Alert deduplication signatures
- Alert count per signature
- Event listeners for real-time notifications

**Impact of Loss:**

- Duplicate alerts may be created
- Alert rate limiting breaks
- Real-time listeners disconnected

---

### 4. **Categorization Cache** ❌ STATEFUL

**Location:** `web/src/runtime/shared/categorization-cache.ts`

```typescript
private cache = new Map<string, CacheEntry>();

interface CacheEntry {
  result: CategorizationResult;
  timestamp: number;
}
```

**What's Stored:**

- Transaction description → Category mapping
- LLM categorization results
- Cache timestamps for TTL

**Impact of Loss:**

- Repeated LLM calls for same transactions
- Increased API costs
- Slower transaction processing

---

### 5. **Circuit Breakers** ❌ STATEFUL

**Location:** `web/src/runtime/shared/error-handling.ts`

```typescript
const circuitBreakers = new Map<string, CircuitBreaker>();

class CircuitBreaker {
  private lastResetTime = Date.now();
  private failureCount = 0;
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";
}
```

**What's Stored:**

- LLM service failure counts
- Circuit breaker states (OPEN/CLOSED)
- Last reset timestamps

**Impact of Loss:**

- Circuit breakers reset on restart
- May call failing services unnecessarily
- No shared state across instances

---

### 6. **Mutex Locks** ❌ STATEFUL

**Location:** `web/src/runtime/shared/mutex.ts`

```typescript
private locks = new Map<string, Promise<void>>();
```

**What's Stored:**

- Transaction ID → Lock promise mapping
- Prevents concurrent processing of same transaction

**Impact of Loss:**

- Race conditions possible on restart
- No distributed locking across instances
- Duplicate transaction processing risk

---

## ✅ Already Stateless Components

These are properly stored in PostgreSQL and are stateless:

1. **Transactions** → `tranasctions` table
2. **Alerts** → `alerts` table (creation is persistent, cache is not)
3. **Habit Insights** → `habit_insights` table
4. **Coach Briefings** → `coach_briefings` table
5. **Shopping Wishlist** → `shopping_wishlist` table
6. **SMS Messages** → `sms_messages` table

---

## 🎯 Migration Plan: Make Everything Stateless

### **Option A: Redis-Only Approach** (Fast, No Schema Changes)

**Advantages:**

- No database schema changes needed
- Fast read/write performance
- TTL/expiry built-in
- Already partially implemented

**Disadvantages:**

- Data lost if Redis crashes (unless using Redis persistence)
- No long-term analytics possible
- Additional infrastructure dependency

#### Implementation Steps:

1. **Conversations** ✅ Already Supported

   ```bash
   # Set environment variable
   REDIS_URL=redis://localhost:6379
   # or
   UPSTASH_REDIS_URL=your-upstash-url
   ```

2. **Agent Sessions** → Store in Redis

   ```typescript
   // Key: session:{sessionId}
   // Value: JSON-serialized session state
   // TTL: 1 hour
   await redis.set(`session:${sessionId}`, JSON.stringify(session), {
     EX: 3600,
   });
   ```

3. **Alert Cache** → Store in Redis

   ```typescript
   // Key: alert:sig:{hash}
   // Value: { count, timestamp }
   // TTL: 5 minutes
   await redis.set(`alert:sig:${hash}`, JSON.stringify({ count, timestamp }), {
     EX: 300,
   });
   ```

4. **Categorization Cache** → Store in Redis

   ```typescript
   // Key: cat:{descHash}
   // Value: { category, subcategory }
   // TTL: 24 hours
   await redis.set(`cat:${hash}`, JSON.stringify(result), {
     EX: 86400,
   });
   ```

5. **Circuit Breakers** → Store in Redis

   ```typescript
   // Key: cb:{serviceName}
   // Value: { state, failureCount, lastReset }
   // TTL: 1 hour
   await redis.set(`cb:${service}`, JSON.stringify(state), {
     EX: 3600,
   });
   ```

6. **Mutex Locks** → Redis Distributed Lock
   ```typescript
   // Use Redlock algorithm
   const lock = await redlock.acquire([`lock:tx:${txId}`], 5000);
   try {
     // Process transaction
   } finally {
     await lock.release();
   }
   ```

---

### **Option B: Database-First Approach** (Recommended for Production)

**Advantages:**

- Permanent storage, no data loss
- Long-term analytics possible
- Query conversations for insights
- No additional infrastructure (PostgreSQL already exists)
- Audit trail and compliance

**Disadvantages:**

- Database schema changes required
- Slightly slower than Redis for high-frequency reads
- More disk space usage

#### Implementation Steps:

#### 1. **Create Conversation Tables**

Add to `data/schema.prisma`:

```prisma
// Conversation sessions
model conversation_sessions {
  id                String              @id @db.Uuid
  user_id           Int
  active_agent      String              @db.VarChar(20) // 'mill', 'chatur', 'sera', 'none'
  mill_session_id   String?             @db.Uuid
  chatur_session_id String?             @db.Uuid
  sera_session_id   String?             @db.Uuid
  created_at        DateTime            @default(now()) @db.Timestamptz(6)
  updated_at        DateTime            @default(now()) @updatedAt @db.Timestamptz(6)
  expires_at        DateTime?           @db.Timestamptz(6) // Optional TTL
  metadata          Json?               @db.Json

  messages          conversation_messages[]
  agent_states      agent_session_states[]

  @@index([user_id, updated_at])
  @@index([expires_at]) // For cleanup jobs
}

// Individual messages in conversations
model conversation_messages {
  id              BigInt             @id @default(autoincrement())
  session_id      String             @db.Uuid
  agent           String             @db.VarChar(20) // 'mill', 'chatur', 'sera', 'user'
  role            String             @db.VarChar(20) // 'user', 'assistant'
  message         String             @db.Text
  timestamp       DateTime           @default(now()) @db.Timestamptz(6)
  metadata        Json?              @db.Json // Attachments, tool calls, etc.

  session         conversation_sessions @relation(fields: [session_id], references: [id], onDelete: Cascade)

  @@index([session_id, timestamp])
}

// Agent-specific session state
model agent_session_states {
  id              String            @id @db.Uuid
  conversation_id String            @db.Uuid
  agent_type      String            @db.VarChar(20) // 'mill', 'chatur', 'sera'
  session_id      String            @db.Uuid // Agent's internal session ID
  state           Json              @db.Json // Serialized agent state
  created_at      DateTime          @default(now()) @db.Timestamptz(6)
  updated_at      DateTime          @default(now()) @updatedAt @db.Timestamptz(6)

  conversation    conversation_sessions @relation(fields: [conversation_id], references: [id], onDelete: Cascade)

  @@unique([conversation_id, agent_type])
  @@index([conversation_id])
}

// Alert deduplication cache
model alert_cache {
  signature       String            @id @db.VarChar(64)
  count           Int               @default(1)
  first_seen      DateTime          @default(now()) @db.Timestamptz(6)
  last_seen       DateTime          @default(now()) @updatedAt @db.Timestamptz(6)
  expires_at      DateTime          @db.Timestamptz(6)

  @@index([expires_at]) // For cleanup
}

// Transaction categorization cache
model categorization_cache {
  description_hash String           @id @db.VarChar(64)
  category         String           @db.VarChar(100)
  subcategory      String?          @db.VarChar(100)
  confidence       Float?
  cached_at        DateTime         @default(now()) @db.Timestamptz(6)
  expires_at       DateTime         @db.Timestamptz(6)

  @@index([expires_at])
}

// Circuit breaker state
model circuit_breaker_state {
  service_name    String            @id @db.VarChar(100)
  state           String            @db.VarChar(20) // 'CLOSED', 'OPEN', 'HALF_OPEN'
  failure_count   Int               @default(0)
  last_failure    DateTime?         @db.Timestamptz(6)
  last_reset      DateTime          @default(now()) @db.Timestamptz(6)
  updated_at      DateTime          @default(now()) @updatedAt @db.Timestamptz(6)
}

// Distributed locks for transactions
model transaction_locks {
  transaction_id  String            @id @db.VarChar(255)
  locked_by       String            @db.VarChar(255) // Instance/process ID
  locked_at       DateTime          @default(now()) @db.Timestamptz(6)
  expires_at      DateTime          @db.Timestamptz(6)

  @@index([expires_at])
}
```

#### 2. **Update Conversation Store Implementation**

Create `web/src/lib/mill/database-conversation-store.ts`:

```typescript
import { prisma } from "@/lib/prisma";
import type {
  ConversationContext,
  ConversationStore,
} from "@/runtime/shared/conversation-router";

export class DatabaseConversationStore implements ConversationStore {
  async load(userId: string): Promise<ConversationContext | undefined> {
    const session = await prisma.conversation_sessions.findFirst({
      where: {
        user_id: parseInt(userId),
        OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
      },
      include: {
        messages: {
          orderBy: { timestamp: "asc" },
        },
        agent_states: true,
      },
      orderBy: { updated_at: "desc" },
    });

    if (!session) return undefined;

    // Reconstruct ConversationContext from database
    return {
      activeAgent: session.active_agent as any,
      millSessionId: session.mill_session_id ?? undefined,
      chaturSessionId: session.chatur_session_id ?? undefined,
      seraSessionId: session.sera_session_id ?? undefined,
      millSession: this.deserializeAgentState(session.agent_states, "mill"),
      chaturSession: this.deserializeAgentState(session.agent_states, "chatur"),
      seraSession: this.deserializeAgentState(session.agent_states, "sera"),
      conversationHistory: session.messages.map((msg) => ({
        agent: msg.agent as any,
        userMessage: msg.role === "user" ? msg.message : "",
        agentResponse: msg.role === "assistant" ? msg.message : "",
        timestamp: msg.timestamp.toISOString(),
      })),
      updatedAt: session.updated_at.toISOString(),
    };
  }

  async save(userId: string, context: ConversationContext): Promise<void> {
    const sessionId = await this.getOrCreateSessionId(parseInt(userId));

    await prisma.$transaction(async (tx) => {
      // Update main session
      await tx.conversation_sessions.update({
        where: { id: sessionId },
        data: {
          active_agent: context.activeAgent,
          mill_session_id: context.millSessionId,
          chatur_session_id: context.chaturSessionId,
          sera_session_id: context.seraSessionId,
          updated_at: new Date(),
          expires_at: new Date(Date.now() + 3600000), // 1 hour from now
        },
      });

      // Save agent states
      if (context.millSession) {
        await this.saveAgentState(tx, sessionId, "mill", context.millSession);
      }
      if (context.chaturSession) {
        await this.saveAgentState(
          tx,
          sessionId,
          "chatur",
          context.chaturSession
        );
      }
      if (context.seraSession) {
        await this.saveAgentState(tx, sessionId, "sera", context.seraSession);
      }

      // Save new messages (only add new ones)
      const existingCount = await tx.conversation_messages.count({
        where: { session_id: sessionId },
      });

      const newMessages = context.conversationHistory.slice(existingCount);
      for (const msg of newMessages) {
        await tx.conversation_messages.create({
          data: {
            session_id: sessionId,
            agent: msg.agent,
            role: msg.userMessage ? "user" : "assistant",
            message: msg.userMessage || msg.agentResponse,
            timestamp: new Date(msg.timestamp),
          },
        });
      }
    });
  }

  async delete(userId: string): Promise<void> {
    await prisma.conversation_sessions.deleteMany({
      where: { user_id: parseInt(userId) },
    });
  }

  async cleanup(maxAgeMs: number): Promise<void> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    await prisma.conversation_sessions.deleteMany({
      where: {
        OR: [
          { updated_at: { lt: cutoff } },
          { expires_at: { lt: new Date() } },
        ],
      },
    });
  }

  private async getOrCreateSessionId(userId: number): Promise<string> {
    let session = await prisma.conversation_sessions.findFirst({
      where: {
        user_id: userId,
        OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
      },
      orderBy: { updated_at: "desc" },
    });

    if (!session) {
      session = await prisma.conversation_sessions.create({
        data: {
          id: crypto.randomUUID(),
          user_id: userId,
          active_agent: "none",
          expires_at: new Date(Date.now() + 3600000),
        },
      });
    }

    return session.id;
  }

  private async saveAgentState(
    tx: any,
    sessionId: string,
    agentType: string,
    state: any
  ) {
    await tx.agent_session_states.upsert({
      where: {
        conversation_id_agent_type: {
          conversation_id: sessionId,
          agent_type: agentType,
        },
      },
      create: {
        id: crypto.randomUUID(),
        conversation_id: sessionId,
        agent_type: agentType,
        session_id: state.sessionId || crypto.randomUUID(),
        state: JSON.stringify(state),
      },
      update: {
        session_id: state.sessionId,
        state: JSON.stringify(state),
        updated_at: new Date(),
      },
    });
  }

  private deserializeAgentState(states: any[], agentType: string): any {
    const state = states.find((s) => s.agent_type === agentType);
    return state ? JSON.parse(state.state) : undefined;
  }
}
```

#### 3. **Update conversation-store.ts**

```typescript
import { DatabaseConversationStore } from "./database-conversation-store";
import { RedisConversationStore } from "./redis-conversation-store";
import { InMemoryConversationStore } from "@/runtime/shared/conversation-router";

export function getConversationStore(): ConversationStore {
  // Priority: Database > Redis > Memory
  const databaseEnabled = process.env.USE_DATABASE_CONVERSATIONS === "true";
  const redisUrl = process.env.REDIS_URL ?? process.env.UPSTASH_REDIS_URL;

  if (databaseEnabled) {
    console.log(
      "[conversation-store] Using PostgreSQL database for conversations"
    );
    return new DatabaseConversationStore();
  }

  if (redisUrl) {
    console.log("[conversation-store] Using Redis for conversations");
    return new RedisConversationStore(redisUrl);
  }

  console.warn(
    "[conversation-store] REDIS_URL not configured. " +
      "Falling back to in-memory conversations. This is not stateless."
  );
  return new InMemoryConversationStore();
}
```

#### 4. **Add Cleanup Job**

Create `web/src/app/api/cleanup/conversations/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST() {
  try {
    // Delete expired conversations
    const deleted = await prisma.conversation_sessions.deleteMany({
      where: {
        expires_at: { lt: new Date() },
      },
    });

    // Delete old categorization cache
    await prisma.categorization_cache.deleteMany({
      where: {
        expires_at: { lt: new Date() },
      },
    });

    // Delete old alert cache
    await prisma.alert_cache.deleteMany({
      where: {
        expires_at: { lt: new Date() },
      },
    });

    // Delete stale locks
    await prisma.transaction_locks.deleteMany({
      where: {
        expires_at: { lt: new Date() },
      },
    });

    return NextResponse.json({
      success: true,
      deletedConversations: deleted.count,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// This route should be called by a cron job
export const runtime = "nodejs";
```

---

### **Option C: Hybrid Approach** (Best of Both Worlds)

Use **Redis for hot data** and **PostgreSQL for cold storage**:

1. **Active conversations** → Redis (fast access, 1-hour TTL)
2. **Expired conversations** → Archive to PostgreSQL (analytics, compliance)
3. **Caches** → Redis (fast, ephemeral)
4. **Audit trail** → PostgreSQL (permanent record)

**Implementation:**

- Write to both Redis and PostgreSQL
- Read from Redis first, fallback to PostgreSQL
- Archive expired Redis data to PostgreSQL periodically

---

## 🚀 Recommended Implementation Order

### Phase 1: Quick Wins (1-2 days)

1. ✅ Configure REDIS_URL (already supported)
2. Move alert cache to Redis
3. Move categorization cache to Redis
4. Move circuit breakers to Redis

### Phase 2: Core Functionality (3-5 days)

5. Create database schema for conversations
6. Implement DatabaseConversationStore
7. Add cleanup cron jobs
8. Testing and validation

### Phase 3: Advanced Features (5-7 days)

9. Implement distributed locks (Redis or PostgreSQL)
10. Add conversation analytics queries
11. Implement hybrid approach (Redis + PostgreSQL)
12. Add monitoring and alerting

---

## 📈 Performance Considerations

### Redis (Fast)

- **Read latency**: 1-5ms
- **Write latency**: 1-5ms
- **Best for**: High-frequency operations

### PostgreSQL (Durable)

- **Read latency**: 5-20ms (with indexes)
- **Write latency**: 10-50ms
- **Best for**: Permanent storage, complex queries

### Recommendation:

- Use **Redis** for active sessions and caches
- Use **PostgreSQL** for conversation history and analytics
- Hybrid approach for production systems

---

## ✅ Testing Checklist

- [ ] Conversations survive server restart
- [ ] Multiple instances share state correctly
- [ ] No race conditions in distributed locks
- [ ] Cleanup jobs remove expired data
- [ ] Metrics show no data loss
- [ ] Performance meets SLA (<100ms p95)

---

## 🔍 Monitoring

Key metrics to track:

- Conversation session count
- Average session duration
- Cache hit rates
- Database query latency
- Redis memory usage
- Cleanup job success rate

---

## 📝 Environment Variables

```bash
# Database conversations (recommended for production)
USE_DATABASE_CONVERSATIONS=true

# Redis fallback (fast, but ephemeral)
REDIS_URL=redis://localhost:6379
# or
UPSTASH_REDIS_URL=your-upstash-url

# Cleanup job schedule
CONVERSATION_CLEANUP_CRON="0 */6 * * *"  # Every 6 hours
```

---

## 🎯 Success Criteria

A stateless system should:

1. ✅ Survive server restarts without data loss
2. ✅ Scale horizontally across multiple instances
3. ✅ Share state consistently across instances
4. ✅ Handle failures gracefully
5. ✅ Provide audit trail for compliance
6. ✅ Support analytics and insights
