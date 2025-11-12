/**
 * Simple concurrency limiter for parallel task execution.
 * Limits the number of concurrent promises executing at once.
 */
export function createConcurrencyLimiter(limit: number) {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  async function acquire(): Promise<() => void> {
    if (activeCount < limit) {
      activeCount++;
      return release;
    }

    // Wait for a slot to become available
    await new Promise<void>((resolve) => {
      queue.push(resolve);
    });

    activeCount++;
    return release;
  }

  function release() {
    activeCount--;
    const next = queue.shift();
    if (next) {
      next();
    }
  }

  return async function runWithLimit<T>(fn: () => Promise<T>): Promise<T> {
    const releaseSlot = await acquire();
    try {
      return await fn();
    } finally {
      releaseSlot();
    }
  };
}
