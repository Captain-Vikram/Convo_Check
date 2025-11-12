import { PrismaClient } from "../../../data/generated/prisma";

/**
 * Prisma Client Singleton with Connection Pooling
 * 
 * This ensures we reuse database connections across requests,
 * preventing connection exhaustion and improving performance.
 * 
 * Connection pool settings are configured in DATABASE_URL:
 * ?connection_limit=10&pool_timeout=20
 */

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = 
  globalForPrisma.prisma ?? 
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' 
      ? ['query', 'error', 'warn'] 
      : ['error'],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Graceful shutdown handler
 * Ensures connections are closed properly on application exit
 */
export async function disconnectPrisma() {
  await prisma.$disconnect();
}

// Register cleanup handlers
if (typeof process !== 'undefined') {
  process.on('beforeExit', disconnectPrisma);
  process.on('SIGINT', disconnectPrisma);
  process.on('SIGTERM', disconnectPrisma);
}
