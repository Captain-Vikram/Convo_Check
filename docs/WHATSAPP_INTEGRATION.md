# WhatsApp Integration Guide

This guide explains how to wire WhatsApp (Twilio or Meta Business API) into the in-process agent stack so that every inbound message flows through Mill and the conversation router via `POST /api/agent`.

## Overview

1. WhatsApp provider sends a webhook POST to `/api/whatsapp/webhook` (Next.js route).
2. Webhook validates signatures, normalizes the payload, and maps the phone number to a stable `userId` (HMAC or database ID).
3. Webhook calls `POST /api/agent` (or the `processAgentMessage` helper) with `{ userId, message, attachments? }` so the router can pick Mill/Chatur/Sera automatically.
4. The agent system (Mill + router + tools) produces a reply using the users context window.
5. Webhook sends the reply back to WhatsApp via provider REST API.

## Required files and their purpose

| File                                                          | Purpose                                                                                                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/runtime/shared/conversation-router.ts`                   | Core orchestrator that routes between Mill, Chatur, and Sera. Exported singleton keeps sessions in memory when web server is running.                             |
| `web/src/lib/mill/in-process-adapter.ts`                      | Thin wrapper that converts `{ userId, message, attachments }` into a router call and returns the agent response/context. Avoids duplicating conversational logic. |
| `web/src/lib/mill/conversation-store.ts`                      | Chooses Redis (when `REDIS_URL`/`UPSTASH_REDIS_URL` is set) or the bundled in-memory store to persist `ConversationContext` across WhatsApp/web requests.         |
| `web/src/app/api/agent/route.ts`                              | Public API entry point. Validates input, calls the adapter, and returns JSON. All channels call this endpoint.                                                    |
| `web/src/app/api/mill-proxy/route.ts` _(optional)_            | For setups that still proxy to a separate Mill service. Skip when running in-process.                                                                             |
| `web/src/app/api/whatsapp/webhook/route.ts` _(to be created)_ | Provider-facing webhook. Normalizes payload, acquires per-user lock, calls `/api/agent`, and triggers WhatsApp reply.                                             |
| `web/src/lib/session/*` _(planned)_                           | Session store abstractions (in-memory for dev, Redis/Prisma for prod). Keep user context if web process restarts.                                                 |
| `web/src/lib/whatsapp/<provider>.ts`                          | Helper that sends outbound WhatsApp messages (Twilio REST client or Meta Graph API). Encapsulates auth and payload formatting.                                    |
| `docs/API_DOCUMENTATION.md`                                   | Documents `/api/agent` contract for other teams.                                                                                                                  |
| `docs/WHATSAPP_INTEGRATION.md` _(this file)_                  | Step-by-step guidance, file map, and considerations for WhatsApp rollout.                                                                                         |

## Implementation checklist

1. **Webhook route** (`web/src/app/api/whatsapp/webhook/route.ts`)

   - Verify `X-Twilio-Signature` or `X-Hub-Signature-256`.
   - Normalize payload → `{ userId, phoneNumber, message, messageId, timestamp }`.
   - Map phone number to anonymized `userId` (e.g., HMAC with `SERVER_SECRET`).
   - Acquire per-user lock (Redis) to serialize messages.
   - Call `await fetch("/api/agent", { method: "POST", body: {...} })` (include `attachments` when forwarding images/audio) or invoke `processAgentMessage` directly with the same payload.
   - Append reply to the session store and send via Twilio/Meta send helper.

2. **Session store** (`web/src/lib/session/redis-store.ts` + fallback)

   - Persist message history + summaries so context survives restarts.
   - Provide helpers: `getSession(userId)`, `appendMessage(sessionId, message)`, `summarize(sessionId)`.
   - The web adapter already exposes `web/src/lib/mill/conversation-store.ts`; set `REDIS_URL`/`UPSTASH_REDIS_URL` so `/api/agent` automatically uses Redis, otherwise it falls back to the in-memory TTL store.

3. **Send helper** (`web/src/lib/whatsapp/twilio.ts` or `meta.ts`)

   - Wrap provider API call with retries and logging.
   - Sanitize/format outgoing text (emojis, citations, etc.).

4. **Environment setup**

   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER` (or Meta equivalents).
   - `SERVER_SECRET` for HMAC user IDs.
   - `REDIS_URL` (if using Redis) and `DATABASE_URL` for Prisma persistence.
   - `SERVICE_API_TOKEN` for `/api/agent` auth if exposed beyond internal usage.

5. **Testing**
   - Run `npm run dev` inside `web/` and expose via ngrok.
   - Configure provider webhook → `https://<ngrok>.ngrok.io/api/whatsapp/webhook`.
   - Send test messages and verify replies + logs.

## Hurdles and considerations

- **Webhook latency:** Providers expect a fast 200 OK. If LLM calls take longer, enqueue the message (Redis queue) and acknowledge immediately, then send reply asynchronously.
- **Concurrency:** Multiple messages from the same user must be processed in order. Use per-user locks or FIFO queues to avoid prompt overlap.
- **Persistence:** In-memory sessions reset on deploys. For production, persist sessions (Redis) and optionally transcripts (Prisma) so context windows survive restarts.
- **Security:** Always verify provider signatures, store tokens in env vars, and restrict `/api/agent` with bearer tokens if exposed beyond internal network.
- **Scaling:** Running agents in-process ties LLM load to the web server. For heavy traffic, consider the Mill proxy path (separate service) or autoscale the Next server with sticky sessions.
- **Rate limits & retries:** Twilio/Meta impose outbound rate limits; implement retry/backoff and monitor error responses.
- **Observability:** Log message IDs, user IDs (hashed), agent reply time, and errors. Hook Sentry/Grafana for alerts.
- **Compliance:** Be mindful of storing phone numbers; prefer hashing or encrypting sensitive identifiers.

By following the checklist above, deploying the `web/` app automatically spins up the agent system, and wiring WhatsApp becomes a matter of connecting the webhook to `/api/agent` plus handling provider auth and messaging utilities.
