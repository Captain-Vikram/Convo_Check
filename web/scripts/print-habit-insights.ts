import { prisma } from '../src/lib/prisma';

const arg = process.argv[2] || '10';
const take = Math.max(1, Math.min(1000, parseInt(arg, 10) || 10));
const ownerId = 2;

async function main() {
  const insights = await prisma.habit_insights.findMany({
    where: { owner: ownerId },
    orderBy: { date_created: 'desc' },
    take,
  });

  console.log(JSON.stringify({ count: insights.length, ownerId, take }, null, 2));
  console.log(JSON.stringify(insights, null, 2));
}

main()
  .catch((err) => {
    console.error('Error fetching habit_insights:', err);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch (e) {
      // ignore
    }
  });
