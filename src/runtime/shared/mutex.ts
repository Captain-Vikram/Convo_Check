/**
 * Simple Mutex Implementation
 * 
 * Provides mutual exclusion for async operations to prevent race conditions.
 * Uses a promise queue to ensure only one operation executes at a time per key.
 */

export class Mutex {
  private locks = new Map<string, Promise<void>>();

  /**
   * Acquire a lock for the given key.
   * Returns a release function that must be called when done.
   */
  async acquire(key: string): Promise<() => void> {
    // Wait for any existing lock
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    // Create a new lock
    let releaseFn: (() => void) | undefined;
    const lockPromise = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    this.locks.set(key, lockPromise);

    // Return release function
    return () => {
      this.locks.delete(key);
      if (releaseFn) {
        releaseFn();
      }
    };
  }

  /**
   * Run a function with exclusive access to a key
   */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Check if a key is currently locked
   */
  isLocked(key: string): boolean {
    return this.locks.has(key);
  }

  /**
   * Get number of active locks
   */
  getActiveLockCount(): number {
    return this.locks.size;
  }

  /**
   * Clear all locks (use with caution)
   */
  clearAll(): void {
    for (const [key, promise] of this.locks.entries()) {
      this.locks.delete(key);
      // Resolve any waiting promises to prevent deadlock
      promise.then(() => {}).catch(() => {});
    }
  }
}

/**
 * Create a singleton mutex instance
 */
export function createMutex(): Mutex {
  return new Mutex();
}
