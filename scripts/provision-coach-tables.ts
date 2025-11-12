import "dotenv/config";
import { Client } from "pg";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://user:password@host:5432/postgres";

async function run(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();

  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    await client.query(`
      CREATE TABLE IF NOT EXISTS habit_insights (
        id SERIAL PRIMARY KEY,
        habit_id VARCHAR(255) NOT NULL UNIQUE,
        owner INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(255) NOT NULL DEFAULT 'draft',
        transaction_id UUID REFERENCES tranasctions(id) ON DELETE SET NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        habit_label TEXT NOT NULL,
        evidence TEXT NOT NULL,
        counsel TEXT NOT NULL,
        full_text TEXT NOT NULL,
        metrics JSONB,
        recent_transactions JSONB,
        previous_habit_id VARCHAR(255)
      )
    `);

    await client.query(`
      ALTER TABLE habit_insights
        ADD COLUMN IF NOT EXISTS habit_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS owner INTEGER,
        ADD COLUMN IF NOT EXISTS status VARCHAR(255) DEFAULT 'draft',
        ADD COLUMN IF NOT EXISTS transaction_id UUID REFERENCES tranasctions(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS habit_label TEXT,
        ADD COLUMN IF NOT EXISTS evidence TEXT,
        ADD COLUMN IF NOT EXISTS counsel TEXT,
        ADD COLUMN IF NOT EXISTS full_text TEXT,
        ADD COLUMN IF NOT EXISTS metrics JSONB,
        ADD COLUMN IF NOT EXISTS recent_transactions JSONB,
        ADD COLUMN IF NOT EXISTS previous_habit_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS sort INTEGER,
        ADD COLUMN IF NOT EXISTS date_created TIMESTAMPTZ DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS date_updated TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS user_created UUID REFERENCES directus_users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS user_updated UUID REFERENCES directus_users(id) ON DELETE SET NULL
    `);

    await client.query(`
      ALTER TABLE habit_insights
    ALTER COLUMN habit_id SET NOT NULL,
    ALTER COLUMN owner SET NOT NULL,
    ALTER COLUMN status SET NOT NULL,
    ALTER COLUMN recorded_at SET NOT NULL,
    ALTER COLUMN habit_label SET NOT NULL,
    ALTER COLUMN evidence SET NOT NULL,
    ALTER COLUMN counsel SET NOT NULL,
    ALTER COLUMN full_text SET NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS habit_insights_owner_recorded_at_idx
        ON habit_insights(owner, recorded_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS habit_insights_transaction_idx
        ON habit_insights(transaction_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS habit_insights_owner_date_created_idx
        ON habit_insights(owner, date_created DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS habit_snapshots (
        id SERIAL PRIMARY KEY,
        snapshot_id VARCHAR(255) NOT NULL UNIQUE,
        owner INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(255) NOT NULL DEFAULT 'draft',
        sort INTEGER,
        date_created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        date_updated TIMESTAMPTZ,
        generated_at TIMESTAMPTZ,
        transaction_id UUID,
        top_categories JSONB,
        frequent_merchants JSONB,
        spending_by_medium JSONB,
        flags JSONB,
        insights_count INTEGER,
        insight_labels JSONB,
        snapshot_hash VARCHAR(255),
        user_created UUID REFERENCES directus_users(id) ON DELETE SET NULL,
        user_updated UUID REFERENCES directus_users(id) ON DELETE SET NULL,
        trigger VARCHAR(64),
        context_data JSONB NOT NULL,
        summary_data JSONB NOT NULL
      )
    `);

    await client.query(`
      ALTER TABLE habit_snapshots
        ADD COLUMN IF NOT EXISTS snapshot_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS owner INTEGER,
        ADD COLUMN IF NOT EXISTS status VARCHAR(255) DEFAULT 'draft',
        ADD COLUMN IF NOT EXISTS sort INTEGER,
        ADD COLUMN IF NOT EXISTS date_created TIMESTAMPTZ DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS date_updated TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS user_created UUID REFERENCES directus_users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS user_updated UUID REFERENCES directus_users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS trigger VARCHAR(64),
        ADD COLUMN IF NOT EXISTS context_data JSONB,
        ADD COLUMN IF NOT EXISTS summary_data JSONB,
        ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS transaction_id UUID,
        ADD COLUMN IF NOT EXISTS top_categories JSONB,
        ADD COLUMN IF NOT EXISTS frequent_merchants JSONB,
        ADD COLUMN IF NOT EXISTS spending_by_medium JSONB,
        ADD COLUMN IF NOT EXISTS flags JSONB,
        ADD COLUMN IF NOT EXISTS insights_count INTEGER,
        ADD COLUMN IF NOT EXISTS insight_labels JSONB,
        ADD COLUMN IF NOT EXISTS snapshot_hash VARCHAR(255)
    `);

    await client.query(`
      ALTER TABLE habit_snapshots
        ALTER COLUMN snapshot_id SET NOT NULL,
        ALTER COLUMN owner SET NOT NULL,
        ALTER COLUMN status SET NOT NULL,
        ALTER COLUMN date_created SET NOT NULL,
        ALTER COLUMN context_data SET NOT NULL,
        ALTER COLUMN summary_data SET NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS habit_snapshots_owner_date_created_idx
        ON habit_snapshots(owner, date_created DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS habit_snapshots_owner_generated_at_idx
        ON habit_snapshots(owner, generated_at DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS habit_snapshot_insights (
        id SERIAL PRIMARY KEY,
        snapshot INTEGER NOT NULL REFERENCES habit_snapshots(id) ON DELETE CASCADE,
        insight INTEGER NOT NULL REFERENCES habit_insights(id) ON DELETE CASCADE,
        confidence NUMERIC(5,4),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS habit_snapshot_insights_snapshot_insight_unique
        ON habit_snapshot_insights(snapshot, insight)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS habit_snapshot_insights_insight_idx
        ON habit_snapshot_insights(insight)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS coach_briefings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(255) NOT NULL DEFAULT 'draft',
        sort INTEGER,
        headline TEXT NOT NULL,
        counsel TEXT NOT NULL,
        evidence TEXT,
        trigger VARCHAR(64),
        delivered BOOLEAN NOT NULL DEFAULT FALSE,
        delivered_at TIMESTAMPTZ,
        date_created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        date_updated TIMESTAMPTZ,
        insight_hash VARCHAR(255) NOT NULL,
        metadata JSONB,
        snapshot INTEGER REFERENCES habit_snapshots(id) ON DELETE SET NULL,
        user_created UUID REFERENCES directus_users(id) ON DELETE SET NULL,
        user_updated UUID REFERENCES directus_users(id) ON DELETE SET NULL
      )
    `);

    await client.query(`
      ALTER TABLE coach_briefings
        ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid(),
        ADD COLUMN IF NOT EXISTS owner INTEGER,
        ADD COLUMN IF NOT EXISTS status VARCHAR(255) DEFAULT 'draft',
        ADD COLUMN IF NOT EXISTS sort INTEGER,
        ADD COLUMN IF NOT EXISTS headline TEXT,
        ADD COLUMN IF NOT EXISTS counsel TEXT,
        ADD COLUMN IF NOT EXISTS evidence TEXT,
        ADD COLUMN IF NOT EXISTS trigger VARCHAR(64),
        ADD COLUMN IF NOT EXISTS delivered BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS date_created TIMESTAMPTZ DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS date_updated TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS insight_hash VARCHAR(255),
        ADD COLUMN IF NOT EXISTS metadata JSONB,
        ADD COLUMN IF NOT EXISTS snapshot INTEGER,
        ADD COLUMN IF NOT EXISTS user_created UUID REFERENCES directus_users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS user_updated UUID REFERENCES directus_users(id) ON DELETE SET NULL
    `);

    await client.query(`
      ALTER TABLE coach_briefings
  ALTER COLUMN owner SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN date_created SET NOT NULL,
  ALTER COLUMN headline SET NOT NULL,
  ALTER COLUMN counsel SET NOT NULL,
  ALTER COLUMN insight_hash SET NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS coach_briefings_owner_date_created_idx
        ON coach_briefings(owner, date_created DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS coach_briefings_owner_delivered_idx
        ON coach_briefings(owner, delivered)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS coach_briefings_insight_hash_idx
        ON coach_briefings(insight_hash)
    `);

    console.log("Tables provisioned successfully.");
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("Failed to provision tables:", error);
  process.exitCode = 1;
});
