# Directus Configuration Guide

## 🎨 Making Collections User-Friendly in Directus

### Overview

All tables are already Directus-compatible with standard fields:

- ✅ `status` - Workflow state (draft/published/archived)
- ✅ `date_created` / `date_updated` - Automatic timestamps
- ✅ `user_created` / `user_updated` - Track who modified records
- ✅ `owner` - Relationship to users table
- ✅ Proper indexes for fast queries

---

## 📊 Collection: `habit_insights`

### Display Configuration (Directus UI)

**Display Template**:

```
{{habit_label}} - {{evidence}} ({{owner.name}})
```

**Field Display Settings**:
| Field | Display Name | Interface | Width | Note |
|-------|--------------|-----------|-------|------|
| `id` | ID | Input (readonly) | Half | Primary key |
| `habit_id` | Habit Hash | Input (readonly) | Half | Unique identifier |
| `owner` | User | Many-to-One | Half | Shows user name |
| `status` | Status | Dropdown | Half | draft/published |
| `habit_label` | Pattern Type | Input | Full | e.g., "frequent-small" |
| `evidence` | Evidence | Textarea | Full | Transaction details |
| `counsel` | AI Advice | Textarea | Full | Recommendations |
| `full_text` | Full Analysis | Textarea (wysiwyg) | Full | Complete context |
| `metrics` | Metrics | JSON | Full | Spending statistics |
| `recent_transactions` | Recent Txns | JSON | Full | Transaction history |
| `transaction_id` | Related Transaction | Many-to-One | Half | Link to transaction |
| `recorded_at` | Analyzed At | Datetime | Half | When habit detected |
| `previous_habit_id` | Previous Habit | Input | Half | Chain tracking |
| `date_created` | Created | Datetime (readonly) | Half | Auto-set |
| `date_updated` | Updated | Datetime (readonly) | Half | Auto-set |

**Layout Configuration**:

```
┌─────────────────────────────────────┐
│ Habit Pattern Analysis              │
├─────────────────────────────────────┤
│ Pattern Type: [habit_label]         │
│ User: [owner dropdown]               │
│ Status: [published/draft]            │
│ Analyzed At: [recorded_at]           │
├─────────────────────────────────────┤
│ Evidence:                            │
│ [evidence textarea]                  │
├─────────────────────────────────────┤
│ AI Advice:                           │
│ [counsel textarea]                   │
├─────────────────────────────────────┤
│ Full Analysis:                       │
│ [full_text wysiwyg]                  │
├─────────────────────────────────────┤
│ Metrics (JSON):                      │
│ [metrics code editor]                │
├─────────────────────────────────────┤
│ Related Transaction:                 │
│ [transaction_id dropdown]            │
│ Previous Habit: [previous_habit_id]  │
└─────────────────────────────────────┘
```

**Collection Settings**:

- **Icon**: `psychology` (brain icon)
- **Color**: `#9C27B0` (purple)
- **Sort Field**: `recorded_at DESC`
- **Archive Field**: `status`
- **Archive Value**: `archived`

**Filters Presets**:

1. **Active Habits** - `status = published AND recorded_at > 30 days ago`
2. **High Risk** - `metrics.riskLevel = high`
3. **By User** - `owner = current_user`

---

## 📊 Collection: `coach_briefings`

### Display Configuration (Directus UI)

**Display Template**:

```
{{headline}} - {{owner.name}} ({{trigger}})
```

**Field Display Settings**:
| Field | Display Name | Interface | Width | Note |
|-------|--------------|-----------|-------|------|
| `id` | ID | UUID (readonly) | Half | Primary key |
| `owner` | User | Many-to-One | Half | Shows user name |
| `status` | Status | Dropdown | Half | draft/published |
| `headline` | Headline | Input | Full | Brief summary |
| `counsel` | Coaching Advice | Textarea | Full | Main guidance |
| `evidence` | Evidence | Textarea | Full | Supporting data |
| `trigger` | Trigger Type | Dropdown | Half | analyst/manual |
| `insight_hash` | Insight Hash | Input (readonly) | Half | Dedup key |
| `delivered` | Delivered | Toggle | Half | Sent to user? |
| `delivered_at` | Delivered At | Datetime | Half | When sent |
| `metadata` | Metadata | JSON | Full | Additional context |
| `snapshot` | Related Snapshot | Many-to-One | Half | Link to snapshot |
| `date_created` | Created | Datetime (readonly) | Half | Auto-set |
| `date_updated` | Updated | Datetime (readonly) | Half | Auto-set |

**Layout Configuration**:

```
┌─────────────────────────────────────┐
│ Coaching Briefing                   │
├─────────────────────────────────────┤
│ Headline: [headline input]           │
│ User: [owner dropdown]               │
│ Status: [published/draft]            │
│ Trigger: [analyst/manual]            │
├─────────────────────────────────────┤
│ Coaching Advice:                     │
│ [counsel textarea]                   │
├─────────────────────────────────────┤
│ Evidence:                            │
│ [evidence textarea]                  │
├─────────────────────────────────────┤
│ Delivery Status:                     │
│ Delivered: [toggle]                  │
│ Delivered At: [delivered_at]         │
├─────────────────────────────────────┤
│ Metadata (JSON):                     │
│ [metadata code editor]               │
├─────────────────────────────────────┤
│ Related Snapshot: [snapshot]         │
│ Insight Hash: [insight_hash]         │
└─────────────────────────────────────┘
```

**Collection Settings**:

- **Icon**: `psychology_alt` (coach icon)
- **Color**: `#4CAF50` (green)
- **Sort Field**: `date_created DESC`
- **Archive Field**: `status`
- **Archive Value**: `archived`

**Filters Presets**:

1. **Pending Delivery** - `delivered = false AND status = published`
2. **Recent Briefings** - `date_created > 7 days ago`
3. **By Trigger** - `trigger = analyst OR trigger = manual`
4. **By User** - `owner = current_user`

---

## 📊 Existing Collections (Already Configured)

### `tranasctions` (Note: typo in schema)

**Display Template**: `{{target_party}} - {{amount}} {{currency}} ({{type}})`
**Icon**: `receipt_long`
**Color**: `#2196F3` (blue)

### `sms_messages`

**Display Template**: `{{sender_name}} at {{time}} - {{receiver_phone_number}}`
**Icon**: `message`
**Color**: `#FF9800` (orange)

### `users`

**Display Template**: `{{name}} ({{whatsapp_number}})`
**Icon**: `person`
**Color**: `#607D8B` (grey)

### `habit_snapshots`

**Display Template**: `Snapshot {{snapshot_id}} - {{owner.name}}`
**Icon**: `photo_camera`
**Color**: `#795548` (brown)

---

## 🎨 Recommended Directus Customizations

### 1. **Dashboard Widgets**

Create a dashboard for financial insights:

```json
{
  "widgets": [
    {
      "type": "metric",
      "collection": "habit_insights",
      "field": "id",
      "function": "count",
      "filter": {
        "date_created": { "_gte": "$NOW(-7 days)" }
      },
      "label": "Habits This Week"
    },
    {
      "type": "metric",
      "collection": "coach_briefings",
      "field": "id",
      "function": "count",
      "filter": {
        "delivered": false
      },
      "label": "Pending Briefings"
    },
    {
      "type": "list",
      "collection": "habit_insights",
      "limit": 5,
      "sortField": "recorded_at",
      "sortDirection": "DESC",
      "label": "Recent Habits"
    }
  ]
}
```

### 2. **Relationships View**

Enable relationship graph:

- Users → Habit Insights (one-to-many)
- Users → Coach Briefings (one-to-many)
- Users → Transactions (one-to-many)
- Users → SMS Messages (one-to-many)
- Transactions → Habit Insights (one-to-many)
- Habit Snapshots → Coach Briefings (one-to-many)

### 3. **Collection Icons & Colors**

Ensure visual consistency:

```
habit_insights    → 🧠 Purple  (#9C27B0)
coach_briefings   → 💬 Green   (#4CAF50)
tranasctions      → 🧾 Blue    (#2196F3)
sms_messages      → 📱 Orange  (#FF9800)
users             → 👤 Grey    (#607D8B)
habit_snapshots   → 📸 Brown   (#795548)
alerts (future)   → 🚨 Red     (#F44336)
```

---

## 🔍 Data Validation Rules

### `habit_insights`

```json
{
  "habit_label": {
    "required": true,
    "validation": "_notEmpty"
  },
  "evidence": {
    "required": true,
    "validation": "_notEmpty"
  },
  "counsel": {
    "required": true,
    "validation": "_notEmpty"
  },
  "owner": {
    "required": true,
    "validation": "_notNull"
  }
}
```

### `coach_briefings`

```json
{
  "headline": {
    "required": true,
    "validation": "_notEmpty",
    "maxLength": 255
  },
  "counsel": {
    "required": true,
    "validation": "_notEmpty"
  },
  "insight_hash": {
    "required": true,
    "validation": "_notEmpty"
  },
  "owner": {
    "required": true,
    "validation": "_notNull"
  }
}
```

---

## 🔐 Permissions Setup

### Public Role (No Access)

- All collections: Read = ❌, Create = ❌, Update = ❌, Delete = ❌

### User Role (Own Data Only)

```json
{
  "habit_insights": {
    "read": { "owner": { "_eq": "$CURRENT_USER" } },
    "create": false,
    "update": false,
    "delete": false
  },
  "coach_briefings": {
    "read": { "owner": { "_eq": "$CURRENT_USER" } },
    "create": false,
    "update": { "delivered": true },
    "delete": false
  },
  "tranasctions": {
    "read": { "owner": { "_eq": "$CURRENT_USER" } },
    "create": false,
    "update": false,
    "delete": false
  }
}
```

### Admin Role (Full Access)

- All collections: CRUD = ✅

### Service Role (Agent Access)

- Used by API with SERVICE_API_TOKEN
- Can create/update all collections
- Cannot delete

---

## 📈 Analytics Views

### Custom SQL Views (Optional)

Create read-only views for analytics:

```sql
-- User spending summary
CREATE VIEW user_spending_summary AS
SELECT
    u.id,
    u.name,
    COUNT(DISTINCT hi.id) as total_habits,
    COUNT(DISTINCT cb.id) as total_briefings,
    COUNT(DISTINCT t.id) as total_transactions,
    SUM(t.amount) FILTER (WHERE t.type = 'debit') as total_spent,
    SUM(t.amount) FILTER (WHERE t.type = 'credit') as total_income
FROM users u
LEFT JOIN habit_insights hi ON hi.owner = u.id
LEFT JOIN coach_briefings cb ON cb.owner = u.id
LEFT JOIN tranasctions t ON t.owner = u.id
GROUP BY u.id, u.name;

-- Recent insights by category
CREATE VIEW recent_habits_by_category AS
SELECT
    t.category,
    COUNT(hi.id) as habit_count,
    hi.habit_label,
    AVG((hi.metrics->>'averageAmount')::numeric) as avg_amount
FROM habit_insights hi
JOIN tranasctions t ON t.id::text = hi.transaction_id
WHERE hi.date_created > NOW() - INTERVAL '30 days'
GROUP BY t.category, hi.habit_label;
```

---

## 🚀 Quick Start Checklist

After running migrations and tests:

1. ✅ Open Directus admin panel
2. ✅ Verify `habit_insights` collection appears
3. ✅ Verify `coach_briefings` collection appears
4. ✅ Set collection icons and colors (Settings → Data Model)
5. ✅ Configure display templates for each collection
6. ✅ Set up field interfaces (textarea, JSON editor, etc.)
7. ✅ Create filter presets for common queries
8. ✅ Set up permissions for User and Service roles
9. ✅ Create dashboard widgets for monitoring
10. ✅ Test creating a record manually to verify layout

---

## 💡 Tips for Maintenance

1. **Use JSON Field Formatting**: Enable syntax highlighting for `metrics` and `metadata` fields
2. **Enable Versioning**: Track changes to briefings and insights over time
3. **Set Up Webhooks**: Trigger notifications when new briefings are created
4. **Use Translations**: Add multi-language support for field labels
5. **Create Flows**: Automate delivery of briefings when `status = published`
6. **Archive Old Data**: Periodically move old records to `archived` status
7. **Monitor Performance**: Use Directus insights to track query performance
8. **Backup Regularly**: Schedule regular database backups via Directus

---

## 🎯 Expected User Experience

When agents create records via API:

1. **Habit Insight Created**:

   - Status = `published` (immediately visible)
   - Owner = User ID (filtered by user)
   - Transaction link = Clickable relationship
   - Metrics = Pretty JSON display
   - Timestamp = Automatic

2. **Coach Briefing Created**:

   - Status = `published` (immediately visible)
   - Owner = User ID (filtered by user)
   - Delivered = `false` (pending)
   - Snapshot link = Clickable relationship
   - Metadata = Pretty JSON display

3. **User Views in Directus**:
   - Sees only their own records (filtered by owner)
   - Can mark briefings as delivered
   - Cannot edit AI-generated content
   - Can view related transactions
   - Can see habit history timeline

All fields are human-readable, relationships are clickable, and JSON data is formatted for easy reading! 🎨
