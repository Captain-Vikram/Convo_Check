import "dotenv/config";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://user:password@host:5432/postgres";

async function run(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();

  try {
    console.log("\n=== HABIT INSIGHTS ===");
    const insights = await client.query(`
      SELECT id, habit_id, owner, status, transaction_id, 
             recorded_at, habit_label, 
             metrics::text as metrics,
             recent_transactions::text as recent_transactions
      FROM habit_insights 
      ORDER BY recorded_at DESC 
      LIMIT 5
    `);
    
    console.log(`\nFound ${insights.rows.length} habit insights:`);
    insights.rows.forEach((row, idx) => {
      console.log(`\n--- Insight ${idx + 1} ---`);
      console.log(`ID: ${row.id}`);
      console.log(`Habit ID: ${row.habit_id}`);
      console.log(`Owner: ${row.owner}`);
      console.log(`Status: ${row.status}`);
      console.log(`Transaction ID: ${row.transaction_id}`);
      console.log(`Recorded: ${row.recorded_at}`);
      console.log(`Label: ${row.habit_label}`);
      console.log(`\nMetrics:`);
      console.log(row.metrics || "null");
      console.log(`\nRecent Transactions:`);
      console.log(row.recent_transactions || "null");
    });

    console.log("\n\n=== HABIT SNAPSHOTS ===");
    const snapshots = await client.query(`
      SELECT id, snapshot_id, owner, status,
             context_data::text as context_data,
             summary_data::text as summary_data,
             date_created
      FROM habit_snapshots 
      ORDER BY date_created DESC 
      LIMIT 5
    `);
    
    console.log(`\nFound ${snapshots.rows.length} habit snapshots:`);
    snapshots.rows.forEach((row, idx) => {
      console.log(`\n--- Snapshot ${idx + 1} ---`);
      console.log(`ID: ${row.id}`);
      console.log(`Snapshot ID: ${row.snapshot_id}`);
      console.log(`Owner: ${row.owner}`);
      console.log(`Status: ${row.status}`);
      console.log(`Created: ${row.date_created}`);
      console.log(`\nContext Data:`);
      console.log(row.context_data || "null");
      console.log(`\nSummary Data:`);
      console.log(row.summary_data || "null");
    });

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.end();
  }
}

run().catch(console.error);
