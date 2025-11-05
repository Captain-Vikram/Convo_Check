#!/usr/bin/env node
const { Client } = require('pg');

const DB_URL = process.env.DATABASE_URL ;
const useSsl = process.env.DATABASE_SSL === 'true';
const client = new Client({ connectionString: DB_URL, ssl: useSsl ? { rejectUnauthorized: false } : false });

function safeName(n) {
  // Basic safety: wrap with double-quotes to preserve case and special chars
  return '"' + String(n).replace(/"/g, '""') + '"';
}

(async () => {
  try {
    console.log('Connecting to database...');
    await client.connect();

    // Get list of tables in public schema
    const tablesRes = await client.query(
      `SELECT table_schema, table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    );

    const results = [];

    for (const row of tablesRes.rows) {
      const schema = row.table_schema;
      const table = row.table_name;
      console.log('\n--- TABLE:', schema + '.' + table, '---');

      // Get columns
      const colsRes = await client.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, table]
      );

      console.log('Columns:');
      console.table(colsRes.rows);

      // Fetch sample rows (limit 5)
      const qualified = safeName(schema) + '.' + safeName(table);
      let sampleRows = [];
      try {
        const sampleRes = await client.query(`SELECT * FROM ${qualified} LIMIT 5`);
        sampleRows = sampleRes.rows;
        console.log('Sample rows (up to 5):', JSON.stringify(sampleRows, null, 2));
      } catch (err) {
        console.error('Could not fetch sample rows for', schema + '.' + table, '-', err.message);
      }

      results.push({ schema, table, columns: colsRes.rows, samples: sampleRows });
    }

    // Optionally, you could write results to a file. For now we just printed them.
    console.log('\nInspection complete. Retrieved', results.length, 'tables.');
  } catch (err) {
    console.error('ERROR:', err && err.message ? err.message : err);
    process.exitCode = 2;
  } finally {
    try { await client.end(); } catch (_) {}
  }
})();
