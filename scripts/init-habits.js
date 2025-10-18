/**
 * Initialize Habits CLI
 * 
 * Analyzes existing transactions and creates initial habit entries.
 * Run: node scripts/init-habits.js
 */

import { initializeHabitsFromTransactions } from '../src/runtime/param/habit-tracker.js';

console.log('🎯 Param Agent - Habit Tracker Initialization\n');
console.log('This will analyze all transactions and create habit entries.');
console.log('Each transaction will be analyzed with LLM for spending patterns.\n');

const start = Date.now();

try {
  const count = await initializeHabitsFromTransactions({
    baseDir: './data',
    lookbackCount: 5,
    model: 'gemini-2.0-flash-exp',
  });

  const duration = ((Date.now() - start) / 1000).toFixed(2);

  console.log(`\n✅ Success!`);
  console.log(`📊 Created ${count} habit entries`);
  console.log(`⏱️  Completed in ${duration}s`);
  console.log(`\n📁 Output:`);
  console.log(`   - data/habits.csv (habit log)`);
  console.log(`   - data/habit-snapshots/*.json (vector snapshots for Chatur)`);
} catch (error) {
  console.error('\n❌ Failed to initialize habits:', error);
  process.exit(1);
}
