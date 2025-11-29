import * as PrismaModule from '../web/src/lib/prisma';

async function main() {
  // Some environments export TS modules differently; use a tolerant access pattern
  const prisma = (PrismaModule as any).prisma ?? (PrismaModule as any).default ?? PrismaModule;

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
    try { await prisma.$disconnect(); } catch {};
  }
}

main();
