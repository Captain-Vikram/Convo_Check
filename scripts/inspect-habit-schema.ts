import "dotenv/config";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://user:password@host:5432/postgres";

async function run(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const tables = ["habit_insights", "habit_snapshots", "coach_briefings", "transactions", "users"];

    for (const table of tables) {
      console.log(`\n=== ${table.toUpperCase()} ===`);
      const columns = await client.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [table]
      );

      if (columns.rows.length === 0) {
        console.log("Table not found.");
        continue;
      }

      for (const col of columns.rows) {
        console.log(`- ${col.column_name} (${col.data_type})${col.is_nullable === "NO" ? " NOT NULL" : ""}${col.column_default ? ` DEFAULT ${col.column_default}` : ""}`);
      }

      const indexes = await client.query(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = $1
         ORDER BY indexname`,
        [table]
      );

      if (indexes.rows.length > 0) {
        console.log("\nIndexes:");
        for (const idx of indexes.rows) {
          console.log(`- ${idx.indexname}: ${idx.indexdef}`);
        }
      }
    }
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("Failed to inspect schema:", error);
  process.exit(1);
});
