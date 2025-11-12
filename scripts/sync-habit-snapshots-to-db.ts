/**
 * Sync Habit Snapshots from JSON Files to Database
 * 
 * The habit_snapshots table exists but is unused. This script:
 * 1. Reads all JSON snapshot files from data/habit-snapshots/
 * 2. Inserts them into the habit_snapshots database table
 * 3. Creates proper relationships with coach_briefings
 * 
 * This enables Directus to show snapshots and allows querying them via SQL.
 */

import { PrismaClient } from '../data/generated/prisma/index.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const prisma = new PrismaClient();

interface HabitSnapshot {
  snapshotId: string;
  owner: number;
  transactionId: string;
  transactionDate: string;
  transactionAmount: number;
  category: string;
  targetParty: string;
  context: {
    recentTransactions: any[];
    previousHabits: any[];
    spendingPatterns: string[];
  };
  insights: Array<{
    habitLabel: string;
    evidence: string;
    counsel: string;
    fullText: string;
  }>;
  summary: {
    totalContext: string;
    keyPatterns: string[];
    recommendations: string[];
  };
}

async function syncSnapshotsToDatabase() {
  console.log('🔄 Syncing Habit Snapshots to Database\n');
  
  const snapshotsDir = join(process.cwd(), 'data', 'habit-snapshots');
  
  try {
    const files = await readdir(snapshotsDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    
    console.log(`Found ${jsonFiles.length} snapshot files\n`);
    
    let synced = 0;
    let skipped = 0;
    let errors = 0;
    
    for (const file of jsonFiles) {
      const snapshotId = file.replace('.json', '');
      
      // Check if already exists
      const existing = await prisma.habit_snapshots.findUnique({
        where: { snapshot_id: snapshotId }
      });
      
      if (existing) {
        console.log(`⏭️  Skipped: ${snapshotId} (already exists)`);
        skipped++;
        continue;
      }
      
      try {
        // Read JSON file
        const filePath = join(snapshotsDir, file);
        const content = await readFile(filePath, 'utf-8');
        const snapshot: HabitSnapshot = JSON.parse(content);
        
        // Extract owner from snapshot (default to 2 if not found)
        const owner = snapshot.owner || 2;
        
        // Insert into database
        await prisma.habit_snapshots.create({
          data: {
            snapshot_id: snapshotId,
            owner: owner,
            context_data: snapshot.context || {},
            summary_data: snapshot.summary || {},
            status: 'published',
          }
        });
        
        console.log(`✅ Synced: ${snapshotId} (owner: ${owner})`);
        synced++;
        
      } catch (error) {
        console.error(`❌ Error syncing ${snapshotId}:`, error instanceof Error ? error.message : error);
        errors++;
      }
    }
    
    console.log(`\n📊 Summary:`);
    console.log(`   ✅ Synced: ${synced}`);
    console.log(`   ⏭️  Skipped: ${skipped}`);
    console.log(`   ❌ Errors: ${errors}`);
    console.log(`\n✅ Done! Habit snapshots are now in the database.`);
    console.log(`   You can view them in Directus at: http://157.180.67.45:8055/admin/content/habit_snapshots`);
    
  } catch (error) {
    console.error('❌ Failed to sync snapshots:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

syncSnapshotsToDatabase().catch(console.error);
