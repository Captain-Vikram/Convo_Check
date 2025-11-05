# Dev→Mill Fraud Alert System

## Objective

Create a pipeline that spots suspicious activity in inbound bank/SMS alerts, stores anomaly records, and prompts Mill to notify the user so they can confirm or block issues quickly.

## Key Behaviours

- Detect anomalies in SMS streams (frequency bursts, duplicate counterparties, high-value debits).
- Persist flagged events with enough context for follow-up.
- Surface alerts proactively via Mill, with optional coaching reinforcement from Chatur.
- Allow acknowledgements to prevent repeat nudges.

## Agents & Responsibilities

- **Dev (agent2)**: Parse SMS, apply anomaly rules, emit transaction payload plus optional `alertTags`, `severity`, and `confidence` fields.
- **Mill (agent1)**: Poll alert store before/while chatting, announce unresolved alerts, let users acknowledge or request detail. Uses new `fetch_alerts` tool (or extended summary tool).
- **Param (agent3)** (optional): Consume alert telemetry for habit insights (e.g., security hygiene reminders).
- **Chatur Coach (agent4)** (optional): Reference alerts in personalization anchors to steer behavioural counselling.

## Data Stores

- **Transactions**: existing ledger augmented with Dev’s new anomaly metadata.
- **Alerts Queue/Table**: fields `id`, `createdAt`, `transactionId`, `rule`, `severity`, `description`, `status`, `ackBy`, `ackAt`.
- **Metrics Cache**: rolling counters per counterparty, per timeframe, and high-value thresholds for Dev rule evaluation.

## Tooling Changes

1. **Dev Output Schema**
   ```json
   {
     "amount": 0,
     "type": "debit",
     "targetParty": "string",
     "currency": "INR",
     "medium": "upi",
     "category": "Other",
     "description": "...",
     "date_of_transaction": "2025-10-02T11:43:22Z",
     "alertTags": ["rapid_repeat"],
     "severity": "high",
     "confidence": 0.92
   }
   ```
2. **Alert Persistence Helpers**: new module (e.g., `src/runtime/dev/alert-store.ts`) for insert/query/update.
3. **Mill Tool**: `fetch_alerts` returning unresolved alerts; accept `acknowledge(id)` mutation command.
4. **Session Middleware**: when Mill handles a user query, call `fetch_alerts` if last check > 5 minutes or new transactions arrived.

## Rules & Threshold Examples

- **Rapid Burst**: ≥3 transactions within 10 minutes → `rapid_burst` tag, severity medium.
- **Duplicate Counterparty**: same payee ≥2 times within 15 minutes AND amount ≥₹2,000 → `repeat_payee`, severity high.
- **Large Withdrawal**: single debit ≥ 0.6 × median weekly income → `large_withdrawal`, severity high.
- **Foreign/Unknown MCC** (if metadata available) → `unusual_merchant`, severity medium.

## Workflow

1. **Dev** receives SMS → parse transaction → compute rolling stats from metrics cache → attach alert metadata if triggered.
2. **Ingestion Service** writes transaction → logs alert to `alerts` store.
3. **Mill** session start/periodic poll → fetch unresolved alerts.
4. If alerts exist, Mill prefaces conversation with summary and CTA (“Want me to list the suspicious transactions?”).
5. User can acknowledge or request details → Mill updates `alerts` via tool.
6. Optional: Coach references alert history in future guidance; Param logs security habits as insights.

## Implementation Phases

1. **Schema & Config**: define alert enums, thresholds, storage interface, TypeScript types.
2. **Dev Enhancements**: extend prompt, add anomaly detectors, unit tests with sample SMS.
3. **Alert Store**: implement persistence + acknowledgment API.
4. **Mill Adapter**: new tool calls, chat middleware, conversational templates.
5. **UX Polish**: dedupe notifications, add acknowledge commands, ensure language friendly.
6. **Coach/Param Integration** (optional): update personalization anchors and insight generation to consume alert context.

## Open Questions

- What SLA for alert delivery? Immediate push vs. next user interaction.
- Do we need severity-based escalation (e.g., SMS/email fallback)?
- Should user be able to mark alert as false positive to refine rules?
- How to secure alert data access if multi-user? Authentication/authorization concerns.
