#!/usr/bin/env node
/**
 * Database Migration Runner
 * Applies the analyst tracking fields migration
 */

import { readFile } from "node:fs/promises";
import { Client } from "pg";

async function runMigration() {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (!databaseUrl) {
    console.error("❌ DATABASE_URL environment variable not set");
    process.exit(1);
  }

  console.log("📦 Connecting to database...");
  const client = new Client({ connectionString: databaseUrl });
  
  try {
    await client.connect();
    console.log("✅ Connected to database");

    console.log("📄 Reading migration file...");
    const migrationSql = await readFile("data/migrations/add-transaction-analysis-tracking.sql", "utf8");
    
    console.log("🔄 Running migration...");
    await client.query(migrationSql);
    
    console.log("✅ Migration completed successfully!");
    console.log("\nAdded fields:");
    console.log("  - analyzed_at (TIMESTAMPTZ)");
    console.log("  - analyzed_version (INTEGER)");
    console.log("  - analysis_notes (VARCHAR(1024))");
    console.log("\nCreated indexes:");
    console.log("  - idx_tranasctions_analyzed_at");
    console.log("  - idx_tranasctions_analysis_version");
    
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) {
      console.log("⚠️  Migration already applied (fields/indexes already exist)");
    } else {
      console.error("❌ Migration failed:", error);
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

runMigration();
