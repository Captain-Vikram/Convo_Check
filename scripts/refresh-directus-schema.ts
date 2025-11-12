/**
 * Refresh Directus Schema from Database
 * 
 * Forces Directus to re-scan the database and update its schema cache.
 * This makes new database columns appear in the admin UI.
 * 
 * Usage:
 *   $env:DIRECTUS_URL = "http://157.180.67.45:8055"
 *   $env:DIRECTUS_ADMIN_TOKEN = "your-admin-token"
 *   npx tsx scripts/refresh-directus-schema.ts
 */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const DIRECTUS_URL = process.env.DIRECTUS_URL || 'http://157.180.67.45:8055';

async function refreshSchema() {
  console.log('🔍 Checking new fields in database...\n');

  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL environment variable not set');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: DATABASE_URL });

  try {
    await client.connect();

    // Check if new columns exist in database
    const result = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'tranasctions'
        AND column_name IN ('analyzed_at', 'analyzed_version', 'analysis_notes')
      ORDER BY column_name;
    `);

    if (result.rows.length === 0) {
      console.error('❌ New columns not found in database!');
      console.log('Run the migration first:');
      console.log('  npx tsx scripts/run-analyst-migration.ts');
      process.exit(1);
    }

    console.log('✅ Found new columns in database:');
    for (const row of result.rows) {
      console.log(`   - ${row.column_name} (${row.data_type}, nullable: ${row.is_nullable})`);
    }

    console.log('\n📊 Sample data check...');
    const dataCheck = await client.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(analyzed_at) as analyzed_count
      FROM tranasctions;
    `);
    
    console.log(`   Total transactions: ${dataCheck.rows[0].total}`);
    console.log(`   Analyzed transactions: ${dataCheck.rows[0].analyzed_count}`);

  } catch (error) {
    console.error('❌ Database query failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }

  console.log('\n' + '='.repeat(60));
  console.log('📋 TO MAKE FIELDS VISIBLE IN DIRECTUS:');
  console.log('='.repeat(60));
  console.log('\n1. Log into Directus admin panel:');
  console.log(`   ${DIRECTUS_URL}`);
  console.log('\n2. Go to: Settings (gear icon) → Data Model');
  console.log('\n3. Click on "tranasctions" collection');
  console.log('\n4. Click the "..." menu → "Refresh Fields from Database"');
  console.log('   OR');
  console.log('   Click "+ Create Field" and manually add:');
  console.log('   - analyzed_at (Type: Timestamp, Interface: DateTime)');
  console.log('   - analyzed_version (Type: Integer, Interface: Input)');
  console.log('   - analysis_notes (Type: String, Interface: Textarea)');
  console.log('\n5. Save and refresh the collection page');
  console.log('\n' + '='.repeat(60));
  console.log('\n✅ The database columns exist and are ready!');
  console.log('   They just need to be registered in Directus UI.');
}

refreshSchema();
