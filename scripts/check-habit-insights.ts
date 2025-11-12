import { PrismaClient } from '../data/generated/prisma/index.js';

const prisma = new PrismaClient();

async function checkHabitInsights() {
  console.log('🔍 Checking habit_insights table...\n');
  
  const total = await prisma.habit_insights.count();
  console.log(`Total habit insights: ${total}`);
  
  const recent = await prisma.habit_insights.findMany({
    take: 5,
    orderBy: { recorded_at: 'desc' },
    select: {
      id: true,
      habit_id: true,
      habit_label: true,
      owner: true,
      recorded_at: true,
      status: true,
    }
  });
  
  console.log('\nRecent 5 habit insights:');
  console.log(JSON.stringify(recent, null, 2));
  
  await prisma.$disconnect();
}

checkHabitInsights().catch(console.error);
