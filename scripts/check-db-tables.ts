/**
 * Quick script to verify database tables exist
 */

import { PrismaClient } from "../data/generated/prisma/index.js";

const prisma = new PrismaClient();

async function checkTables() {
  console.log("🔍 Checking database tables...\n");

  try {
    // Check habit_insights table
    console.log("1️⃣ Checking habit_insights table...");
    const habitsCount = await prisma.habit_insights.count();
    console.log(`   ✅ habit_insights table exists with ${habitsCount} records`);

    // Check coach_briefings table
    console.log("\n2️⃣ Checking coach_briefings table...");
    const briefingsCount = await prisma.coach_briefings.count();
    console.log(`   ✅ coach_briefings table exists with ${briefingsCount} records`);

    // Check users table
    console.log("\n3️⃣ Checking users table...");
    const usersCount = await prisma.users.count();
    console.log(`   ✅ users table exists with ${usersCount} records`);

    // Check tranasctions table
    console.log("\n4️⃣ Checking tranasctions table...");
    const transactionsCount = await prisma.tranasctions.count();
    console.log(`   ✅ tranasctions table exists with ${transactionsCount} records`);

    // Check sms_messages table
    console.log("\n5️⃣ Checking sms_messages table...");
    const smsCount = await prisma.sms_messages.count();
    console.log(`   ✅ sms_messages table exists with ${smsCount} records`);

    console.log("\n✅ All tables verified successfully!");
    console.log("\n📊 Database Summary:");
    console.log(`   - Users: ${usersCount}`);
    console.log(`   - Transactions: ${transactionsCount}`);
    console.log(`   - SMS Messages: ${smsCount}`);
    console.log(`   - Habit Insights: ${habitsCount}`);
    console.log(`   - Coach Briefings: ${briefingsCount}`);

  } catch (error) {
    console.error("\n❌ Error checking tables:", error);
    if (error instanceof Error) {
      console.error("   Message:", error.message);
    }
  } finally {
    await prisma.$disconnect();
  }
}

checkTables();
