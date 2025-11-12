/**
 * Redis-based Query Caching for Convo_Check API
 * 
 * Provides intelligent caching with automatic invalidation
 * to reduce database load and improve response times.
 * 
 * Setup:
 * 1. Create free account at https://upstash.com
 * 2. Create a Redis database
 * 3. Add credentials to .env:
 *    UPSTASH_REDIS_URL=https://...
 *    UPSTASH_REDIS_TOKEN=...
 * 
 * Expected Performance:
 * - Cache Hit: <50ms response time
 * - Cache Miss: Normal DB query time + cache write
 * - Hit Rate Target: 70-80% after warmup
 */

// Type for Redis client (will be dynamically imported)
type Redis = any;

// Initialize Redis client (lazy initialization)
let redis: Redis | null = null;

async function getRedisClient(): Promise<Redis | null> {
  // Skip if Redis is not configured
  if (!process.env.UPSTASH_REDIS_URL || !process.env.UPSTASH_REDIS_TOKEN) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('⚠️  Redis not configured. Caching disabled. Add UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN to .env');
    }
    return null;
  }

  // Return existing client
  if (redis) return redis;

  // Create new client with dynamic import
  try {
    // @ts-ignore - Optional dependency, may not be installed
    const { Redis } = await import('@upstash/redis');
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_URL,
      token: process.env.UPSTASH_REDIS_TOKEN,
    });
    return redis;
  } catch (error) {
    console.error('❌ Failed to initialize Redis (package may not be installed):', error);
    return null;
  }
}

/**
 * Cache Strategy Configuration
 */
export const CACHE_STRATEGIES = {
  // Habits change infrequently, cache longer
  habits: {
    ttl: 300, // 5 minutes
    keyPrefix: 'habits',
  },
  
  // Coach briefings updated ~daily, medium cache
  briefings: {
    ttl: 600, // 10 minutes
    keyPrefix: 'briefings',
  },
  
  // Alerts need to be fresh, short cache
  alerts: {
    ttl: 60, // 1 minute
    keyPrefix: 'alerts',
  },
  
  // Transactions change often during ingestion
  transactions: {
    ttl: 300, // 5 minutes
    keyPrefix: 'transactions',
  },
  
  // User data rarely changes
  users: {
    ttl: 900, // 15 minutes
    keyPrefix: 'users',
  },
} as const;

/**
 * Generic caching wrapper with automatic TTL and key management
 * 
 * @param key - Unique cache key (e.g., "user-123")
 * @param fetcher - Async function that returns data if cache misses
 * @param ttl - Time to live in seconds (default: 5 minutes)
 * @returns Cached data or freshly fetched data
 * 
 * @example
 * const habits = await getCached(
 *   'habits:user-123',
 *   async () => prisma.habit_insights.findMany({ where: { owner: '123' } }),
 *   300
 * );
 */
export async function getCached<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number = 300
): Promise<T> {
  const client = await getRedisClient();

  // If Redis unavailable, bypass cache
  if (!client) {
    return await fetcher();
  }

  try {
    // Try to get from cache
    const cached = await client.get(key);
    
    if (cached) {
      // Cache hit! Parse and return
      const data = JSON.parse(cached as string) as T;
      
      if (process.env.NODE_ENV === 'development') {
        console.log(`✅ Cache HIT: ${key}`);
      }
      
      return data;
    }

    // Cache miss - fetch fresh data
    if (process.env.NODE_ENV === 'development') {
      console.log(`❌ Cache MISS: ${key}`);
    }

    const data = await fetcher();

    // Store in cache for next time
    await client.setex(key, ttl, JSON.stringify(data));

    return data;

  } catch (error) {
    // If cache fails, fall back to direct fetch
    console.error(`⚠️  Cache error for ${key}:`, error);
    return await fetcher();
  }
}

/**
 * Invalidate cache entries matching a pattern
 * 
 * @param pattern - Redis key pattern (e.g., "habits:user-123" or "habits:*")
 * 
 * @example
 * // Invalidate all cache entries for a user
 * await invalidateCache('habits:user-123');
 * 
 * // Invalidate all habits cache
 * await invalidateCache('habits:*');
 */
export async function invalidateCache(pattern: string): Promise<void> {
  const client = await getRedisClient();
  if (!client) return;

  try {
    // If exact key, delete directly
    if (!pattern.includes('*')) {
      await client.del(pattern);
      
      if (process.env.NODE_ENV === 'development') {
        console.log(`🗑️  Invalidated cache: ${pattern}`);
      }
      return;
    }

    // For patterns with wildcards, scan and delete
    const keys = await client.keys(pattern);
    
    if (keys.length > 0) {
      await client.del(...keys);
      
      if (process.env.NODE_ENV === 'development') {
        console.log(`🗑️  Invalidated ${keys.length} cache entries matching: ${pattern}`);
      }
    }

  } catch (error) {
    console.error(`⚠️  Failed to invalidate cache for ${pattern}:`, error);
  }
}

/**
 * Invalidate all cache entries for a specific user across all resources
 * 
 * @param userId - User UUID
 * 
 * @example
 * await invalidateUserCache('123e4567-e89b-12d3-a456-426614174000');
 */
export async function invalidateUserCache(userId: string): Promise<void> {
  await Promise.all([
    invalidateCache(`habits:${userId}`),
    invalidateCache(`briefings:${userId}`),
    invalidateCache(`alerts:${userId}`),
    invalidateCache(`transactions:${userId}`),
  ]);
}

/**
 * Clear all cache entries (use with caution!)
 */
export async function clearAllCache(): Promise<void> {
  const client = await getRedisClient();
  if (!client) return;

  try {
    await client.flushdb();
    console.log('🗑️  Cleared all cache entries');
  } catch (error) {
    console.error('⚠️  Failed to clear cache:', error);
  }
}

/**
 * Get cache statistics (useful for monitoring)
 */
export async function getCacheStats() {
  const client = await getRedisClient();
  if (!client) {
    return {
      enabled: false,
      message: 'Redis not configured',
    };
  }

  try {
    const info = await client.info();
    return {
      enabled: true,
      info,
    };
  } catch (error) {
    return {
      enabled: false,
      error: String(error),
    };
  }
}

/**
 * Helper to build consistent cache keys
 * 
 * @example
 * const key = buildCacheKey('habits', userId, { category: 'food' });
 * // Returns: "habits:user-123:category-food"
 */
export function buildCacheKey(
  prefix: string,
  userId: string,
  filters?: Record<string, any>
): string {
  let key = `${prefix}:${userId}`;

  if (filters && Object.keys(filters).length > 0) {
    const filterString = Object.entries(filters)
      .sort(([a], [b]) => a.localeCompare(b)) // Consistent ordering
      .map(([k, v]) => `${k}-${v}`)
      .join(':');
    key += `:${filterString}`;
  }

  return key;
}
