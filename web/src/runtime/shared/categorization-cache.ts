/**
 * Simple in-memory LRU cache for categorization results.
 * Caches LLM responses to avoid re-categorizing identical transaction patterns.
 */

import type { CategorizationResult } from "./categorize";

interface CacheEntry {
  result: CategorizationResult;
  timestamp: number;
}

const MAX_CACHE_SIZE = 500;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

class CategorizationCache {
  private cache = new Map<string, CacheEntry>();

  /**
   * Generate cache key from transaction text.
   * Normalizes text to improve cache hit rate.
   */
  private generateKey(rawText: string, amount: number): string {
    const normalized = rawText
      .toLowerCase()
      .replace(/\d{2}:\d{2}:\d{2}/g, "TIME") // Remove timestamps
      .replace(/\d{2}[-/]\d{2}[-/]\d{4}/g, "DATE") // Remove dates
      .replace(/\s+/g, " ")
      .trim();
    return `${normalized}|${amount}`;
  }

  /**
   * Get cached categorization if available and not expired.
   */
  get(rawText: string, amount: number): CategorizationResult | null {
    const key = this.generateKey(rawText, amount);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if expired
    const age = Date.now() - entry.timestamp;
    if (age > CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }

    return entry.result;
  }

  /**
   * Store categorization result in cache.
   */
  set(rawText: string, amount: number, result: CategorizationResult): void {
    const key = this.generateKey(rawText, amount);

    // Evict oldest entry if cache is full
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      result,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics for monitoring.
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: MAX_CACHE_SIZE,
      ttlMs: CACHE_TTL_MS,
    };
  }
}

// Singleton instance
export const categorizationCache = new CategorizationCache();
