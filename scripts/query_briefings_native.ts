import { PrismaClient } from '../generated/prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    const rows = await prisma.coach_briefings.findMany({
      where: { owner: 2 },
      orderBy: { date_created: 'desc' },
      take: 10,
    });

    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error('Query failed', err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
