/**
 * Custom error types for agent operations
 */
export class AgentError extends Error {
  constructor(
    message: string,
    public readonly agentId: string,
    public readonly operation: string,
    public readonly isRetryable: boolean = true,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export class LLMError extends AgentError {
  constructor(
    message: string,
    agentId: string,
    public readonly modelName: string,
    cause?: Error,
  ) {
    super(message, agentId, "llm-call", true, cause);
    this.name = "LLMError";
  }
}

export class DataAccessError extends AgentError {
  constructor(
    message: string,
    agentId: string,
    public readonly resourcePath: string,
    cause?: Error,
  ) {
    super(message, agentId, "data-access", true, cause);
    this.name = "DataAccessError";
  }
}

/**
 * Circuit breaker states
 */
enum CircuitState {
  CLOSED = "closed", // Normal operation
  OPEN = "open", // Failing, reject requests
  HALF_OPEN = "half-open", // Testing recovery
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  failureThreshold: number; // Number of failures before opening
  successThreshold: number; // Successes needed to close from half-open
  timeout: number; // Time to wait before trying half-open (ms)
  resetTimeout: number; // Time to reset failure count after success (ms)
}

const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 30_000, // 30 seconds
  resetTimeout: 60_000, // 1 minute
};

/**
 * Circuit breaker for protecting against cascading failures
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private nextAttemptTime = 0;
  private lastResetTime = Date.now();

  constructor(
    private readonly name: string,
    private readonly config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
  ) {}

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttemptTime) {
        if (fallback) {
          console.warn(`[circuit-breaker:${this.name}] Circuit OPEN, using fallback`);
          return fallback();
        }
        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
      // Try to recover
      this.state = CircuitState.HALF_OPEN;
      console.log(`[circuit-breaker:${this.name}] Attempting recovery (HALF_OPEN)`);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      if (fallback) {
        console.warn(`[circuit-breaker:${this.name}] Operation failed, using fallback`);
        return fallback();
      }
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount += 1;
      if (this.successCount >= this.config.successThreshold) {
        this.state = CircuitState.CLOSED;
        this.successCount = 0;
        console.log(`[circuit-breaker:${this.name}] Circuit CLOSED (recovered)`);
      }
    }

    // Reset failure count after reset timeout
    if (Date.now() - this.lastResetTime > this.config.resetTimeout) {
      this.lastResetTime = Date.now();
    }
  }

  private onFailure(): void {
    this.failureCount += 1;
    this.successCount = 0;

    if (this.failureCount >= this.config.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.nextAttemptTime = Date.now() + this.config.timeout;
      console.error(
        `[circuit-breaker:${this.name}] Circuit OPEN after ${this.failureCount} failures`,
      );
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttemptTime = 0;
    console.log(`[circuit-breaker:${this.name}] Circuit manually reset`);
  }
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10_000,
  backoffMultiplier: 2,
};

/**
 * Execute a function with exponential backoff retry
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  shouldRetry: (error: unknown) => boolean = () => true,
): Promise<T> {
  const fullConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: unknown;
  let delay = fullConfig.initialDelayMs;

  for (let attempt = 1; attempt <= fullConfig.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === fullConfig.maxAttempts || !shouldRetry(error)) {
        break;
      }

      console.warn(
        `[retry] Attempt ${attempt}/${fullConfig.maxAttempts} failed, retrying in ${delay}ms`,
        error instanceof Error ? error.message : String(error),
      );

      await sleep(delay);
      delay = Math.min(delay * fullConfig.backoffMultiplier, fullConfig.maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Utility to sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Global circuit breaker registry
 */
const circuitBreakers = new Map<string, CircuitBreaker>();

/**
 * Get or create a circuit breaker
 */
export function getCircuitBreaker(
  name: string,
  config?: Partial<CircuitBreakerConfig>,
): CircuitBreaker {
  if (!circuitBreakers.has(name)) {
    circuitBreakers.set(name, new CircuitBreaker(name, { ...DEFAULT_CIRCUIT_CONFIG, ...config }));
  }
  return circuitBreakers.get(name)!;
}

/**
 * Reset all circuit breakers
 */
export function resetAllCircuitBreakers(): void {
  for (const breaker of circuitBreakers.values()) {
    breaker.reset();
  }
}
