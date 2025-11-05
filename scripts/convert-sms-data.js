/**
 * Convert SMS Export to Optimized CSV Format
 * 
 * Simple Node.js script to convert SMS JSON to the optimized 13-column CSV format
 * Run: node scripts/convert-sms-data.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read SMS export JSON
const smsJsonPath = path.join(__dirname, '..', 'sms_export_20251013.json');
const outputCsvPath = path.join(__dirname, '..', 'data', 'transactions.csv');

console.log('📖 Reading SMS export...');
const smsData = JSON.parse(fs.readFileSync(smsJsonPath, 'utf8'));

const ownerPhone = smsData.owner?.phone || '';
const transactions = [];

console.log(`👤 Owner: ${ownerPhone}`);
console.log(`📨 Processing ${smsData.messages.length} messages...\n`);

// Process each message
for (const msg of smsData.messages) {
  // Skip non-financial messages
  if (msg.is_financial !== 'true') {
    continue;
  }

  // Generate transaction ID from description (ref number) or timestamp
  const transactionId = msg.description || msg.timestamp || generateId();

  // Reshape datetime to ISO format (YYYY-MM-DDTHH:MM:SS)
  const datetime = msg.datetime_readable
    ? msg.datetime_readable.replace(' ', 'T')
    : `${msg.date}T${msg.time}`;

  // Extract date and time
  const date = msg.date || datetime.split('T')[0];
  const time = msg.time || datetime.split('T')[1]?.split('.')[0] || '00:00:00';

  // Build description (extract key info without full SMS text)
  const description = buildDescription(msg);

  // Clean target party (remove trailing ". Ref")
  const targetParty = (msg.targetParty || '').replace(/\.\s*Ref\s*$/, '').trim();

  transactions.push({
    ownerPhone,
    transactionId,
    datetime,
    date,
    time,
    amount: msg.amount || '0',
    currency: msg.currency || '',
    type: msg.type || 'debit',
    targetParty,
    description,
    category: msg.category || 'Financial - High Confidence',
    isFinancial: 'true',
    medium: msg.medium || '',
  });
}

console.log(`✅ Extracted ${transactions.length} financial transactions\n`);

// Write to optimized CSV
const header = 'owner_phone,transaction_id,datetime,date,time,amount,currency,type,target_party,description,category,is_financial,medium';
const rows = transactions.map(t => 
  [
    escapeCsv(t.ownerPhone),
    escapeCsv(t.transactionId),
    escapeCsv(t.datetime),
    escapeCsv(t.date),
    escapeCsv(t.time),
    escapeCsv(t.amount),
    escapeCsv(t.currency),
    escapeCsv(t.type),
    escapeCsv(t.targetParty),
    escapeCsv(t.description),
    escapeCsv(t.category),
    escapeCsv(t.isFinancial),
    escapeCsv(t.medium),
  ].join(',')
);

const csv = [header, ...rows].join('\n') + '\n';

// Ensure data directory exists
const dataDir = path.dirname(outputCsvPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

fs.writeFileSync(outputCsvPath, csv, 'utf8');

console.log(`💾 Saved to: ${outputCsvPath}`);
console.log(`📊 Format: 13 optimized columns`);
console.log(`📏 File size: ${(csv.length / 1024).toFixed(2)} KB\n`);

// Show sample transaction
if (transactions.length > 0) {
  console.log('📝 Sample Transaction:');
  console.log('─'.repeat(60));
  const sample = transactions[0];
  console.log(`Owner Phone:    ${sample.ownerPhone}`);
  console.log(`Transaction ID: ${sample.transactionId}`);
  console.log(`DateTime:       ${sample.datetime}`);
  console.log(`Amount:         ${sample.amount} ${sample.currency}`);
  console.log(`Type:           ${sample.type}`);
  console.log(`Target Party:   ${sample.targetParty}`);
  console.log(`Description:    ${sample.description}`);
  console.log(`Medium:         ${sample.medium || 'N/A'}`);
  console.log('─'.repeat(60));
}

console.log('\n✨ Conversion complete!\n');

// Helper functions
function buildDescription(msg) {
  const parts = [];

  if (msg.description) {
    parts.push(`Ref:${msg.description}`);
  }

  if (msg.targetParty) {
    const party = msg.targetParty.replace(/\.\s*Ref\s*$/, '').trim();
    if (party) {
      parts.push(`to ${party}`);
    }
  }

  // Extract balance from message
  const balanceMatch = msg.message?.match(/AvlBal:\s*Rs\.?\s*([\d.]+)/i);
  if (balanceMatch) {
    parts.push(`AvlBal:Rs${balanceMatch[1]}`);
  }

  return parts.join(', ') || msg.message?.substring(0, 100) || '';
}

function escapeCsv(value) {
  const str = String(value || '');
  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
}

function generateId() {
  return `txn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
