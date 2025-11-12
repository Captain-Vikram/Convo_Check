/**
 * API Client with Rate Limit Handling
 * 
 * Provides robust HTTP client with exponential backoff,
 * retry logic, and 429 (rate limit) handling.
 */

import { logger } from "./logger.js";

export interface FetchWithRetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  timeout?: number;
  signal?: AbortSignal;
}

export class APIError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly response?: Response,
  ) {
    super(message);
    this.name = 'APIError';
  }
}

export class RateLimitError extends APIError {
  constructor(
    message: string,
    public readonly retryAfter: number,
    response?: Response,
  ) {
    super(message, 429, response);
    this.name = 'RateLimitError';
  }
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay with jitter
 */
function calculateBackoff(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  const jitter = Math.random() * 0.3 * exponentialDelay; // Add 0-30% jitter
  return Math.floor(exponentialDelay + jitter);
}

/**
 * Fetch with automatic retry and rate limit handling
 */
export async function fetchWithRetry(
  url: string | URL,
  options: RequestInit & FetchWithRetryOptions = {},
): Promise<Response> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    timeout = 10000,
    signal,
    ...fetchOptions
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Create timeout signal
      const timeoutSignal = AbortSignal.timeout(timeout);
      
      // Combine signals if external signal provided
      const combinedSignal = signal
        ? AbortSignal.any([timeoutSignal, signal])
        : timeoutSignal;

      logger.debug('api-client', `Attempting request (attempt ${attempt + 1}/${maxRetries + 1})`, {
        url: url.toString(),
        method: fetchOptions.method || 'GET',
      });

      const response = await fetch(url, {
        ...fetchOptions,
        signal: combinedSignal,
      });

      // Handle rate limiting (429)
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfter = retryAfterHeader
          ? parseInt(retryAfterHeader, 10) * 1000
          : calculateBackoff(attempt, baseDelay, maxDelay);

        if (attempt < maxRetries) {
          logger.warn('api-client', `Rate limited, retrying after ${retryAfter}ms`, {
            url: url.toString(),
            attempt: attempt + 1,
            retryAfter,
          });
          await sleep(retryAfter);
          continue;
        } else {
          throw new RateLimitError(
            `Rate limit exceeded after ${maxRetries} retries`,
            retryAfter,
            response,
          );
        }
      }

      // Handle server errors (5xx) with retry
      if (response.status >= 500 && attempt < maxRetries) {
        const backoffDelay = calculateBackoff(attempt, baseDelay, maxDelay);
        logger.warn('api-client', `Server error ${response.status}, retrying after ${backoffDelay}ms`, {
          url: url.toString(),
          status: response.status,
          attempt: attempt + 1,
        });
        await sleep(backoffDelay);
        continue;
      }

      // Return response (caller handles 4xx errors)
      return response;

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on abort
      if (lastError.name === 'AbortError') {
        throw lastError;
      }

      // Don't retry on timeout if it's the last attempt
      if (attempt >= maxRetries) {
        break;
      }

      // Network errors: retry with backoff
      const backoffDelay = calculateBackoff(attempt, baseDelay, maxDelay);
      logger.warn('api-client', `Request failed, retrying after ${backoffDelay}ms`, {
        url: url.toString(),
        attempt: attempt + 1,
        error: lastError.message,
      });
      await sleep(backoffDelay);
    }
  }

  // All retries exhausted
  throw lastError || new Error('Request failed after all retries');
}

/**
 * Fetch JSON with retry logic
 */
export async function fetchJSON<T = any>(
  url: string | URL,
  options: RequestInit & FetchWithRetryOptions = {},
): Promise<T> {
  const response = await fetchWithRetry(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new APIError(
      `HTTP ${response.status}: ${errorText}`,
      response.status,
      response,
    );
  }

  return (await response.json()) as T;
}

/**
 * POST JSON with retry logic
 */
export async function postJSON<T = any>(
  url: string | URL,
  body: any,
  options: Omit<RequestInit & FetchWithRetryOptions, 'method' | 'body'> = {},
): Promise<T> {
  return fetchJSON<T>(url, {
    ...options,
    method: 'POST',
    body: JSON.stringify(body),
  });
}
