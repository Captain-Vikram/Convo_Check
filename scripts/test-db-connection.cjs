#!/usr/bin/env node
const { Client } = require('pg');

// Fallback to the provided DATABASE_URL if env var is not set
const DB_URL = process.env.DATABASE_URL;

// Try a plain (non-SSL) connection first. If your server requires SSL, set
// process.env.DATABASE_SSL=true or change this to { ssl: { rejectUnauthorized: false } }.
const useSsl = process.env.DATABASE_SSL === 'true';
const client = new Client({ connectionString: DB_URL, ssl: useSsl ? { rejectUnauthorized: false } : false });

(async () => {
  try {
    console.log('Connecting to database...');
    await client.connect();
    console.log('Connected. Running test queries...');

    const nowRes = await client.query("SELECT NOW() AS now, version() AS version");
    console.log('Server info:', nowRes.rows[0]);

    const tablesRes = await client.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
      LIMIT 5
    `);
    console.log('Public tables (up to 5):', tablesRes.rows);

    console.log('Done.');
  } catch (err) {
    console.error('ERROR:', err && err.message ? err.message : err);
    process.exitCode = 2;
  } finally {
    try { await client.end(); } catch (_) {}
  }
})();
