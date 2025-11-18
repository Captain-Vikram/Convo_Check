/**
 * Circuit Breaker Pattern Implementation
 * 
 * Prevents cascading failures by monitoring error rates and temporarily
 * failing fast when error threshold is exceeded.
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Too many failures, requests fail immediately
 * - HALF_OPEN: Testing if service recovered, limited requests allowed
 */

import { logger } from "./logger";

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerOptions {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time in ms to wait before attempting recovery */
  resetTimeout: number;
  /** Rolling window size for failure tracking (ms) */
  windowSize: number;
  /** Component name for logging */
  name: string;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  rejections: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private rejections: number = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private nextAttemptTime: number = 0;
  private recentFailures: number[] = []; // Timestamps of recent failures

  constructor(private options: CircuitBreakerOptions) {}

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>, fallback?: () => T): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      // Check if we should attempt recovery
      if (Date.now() >= this.nextAttemptTime) {
        this.state = CircuitState.HALF_OPEN;
        logger.info(this.options.name, "Circuit breaker entering HALF_OPEN state");
      } else {
        this.rejections++;
        logger.warn(this.options.name, "Circuit breaker OPEN, request rejected", {
          failures: this.failures,
          nextAttempt: new Date(this.nextAttemptTime).toISOString(),
        });
        
        if (fallback) {
          return fallback();
        }
        throw new Error(`Circuit breaker OPEN for ${this.options.name}`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(); // May change state to OPEN
      
      // Use fallback if circuit opened after this failure
      // @ts-expect-error - state can be OPEN after onFailure() call
      if (fallback && this.state === CircuitState.OPEN) {
        logger.info(this.options.name, "Using fallback due to circuit breaker OPEN");
        return fallback();
      }
      
      throw error;
    }
  }

  private onSuccess(): void {
    this.successes++;
    this.lastSuccessTime = Date.now();
    
    if (this.state === CircuitState.HALF_OPEN) {
      // Recovery successful
      this.state = CircuitState.CLOSED;
      this.failures = 0;
      this.recentFailures = [];
      logger.info(this.options.name, "Circuit breaker CLOSED (recovered)", {
        successes: this.successes,
      });
    }
  }

  private onFailure(): void {
    this.failures++;
    const now = Date.now();
    this.lastFailureTime = now;
    this.recentFailures.push(now);
    
    // Remove failures outside the rolling window
    const windowStart = now - this.options.windowSize;
    this.recentFailures = this.recentFailures.filter(t => t >= windowStart);
    
    if (this.state === CircuitState.HALF_OPEN) {
      // Recovery attempt failed
      this.openCircuit();
      logger.warn(this.options.name, "Circuit breaker OPEN (recovery failed)");
    } else if (this.recentFailures.length >= this.options.failureThreshold) {
      // Too many failures in window
      this.openCircuit();
      logger.error(this.options.name, "Circuit breaker OPEN (threshold exceeded)", new Error("Threshold exceeded"), {
        failures: this.failures,
        recentFailures: this.recentFailures.length,
        threshold: this.options.failureThreshold,
      });
    }
  }

  private openCircuit(): void {
    this.state = CircuitState.OPEN;
    this.nextAttemptTime = Date.now() + this.options.resetTimeout;
  }

  /**
   * Get current circuit breaker statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      rejections: this.rejections,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
    };
  }

  /**
   * Manually reset the circuit breaker
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.rejections = 0;
    this.recentFailures = [];
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.nextAttemptTime = 0;
    logger.info(this.options.name, "Circuit breaker manually reset");
  }
}

/**
 * Create a circuit breaker with sensible defaults for LLM calls
 */
export function createLLMCircuitBreaker(name: string): CircuitBreaker {
  return new CircuitBreaker({
    name,
    failureThreshold: 5, // Open after 5 failures
    resetTimeout: 60000, // Try recovery after 1 minute
    windowSize: 120000, // 2 minute rolling window
  });
}
