/**
 * Error Handling Utilities
 * 
 * Provides decorators and utilities to reduce repetitive try-catch blocks
 * and standardize error handling across the codebase.
 */

import { logger } from "./logger.js";

export interface ErrorHandlerOptions {
  /** Component name for logging context */
  component: string;
  /** Custom error message prefix */
  message?: string;
  /** Whether to rethrow the error after logging */
  rethrow?: boolean;
  /** Whether to suppress logging (useful for expected errors) */
  silent?: boolean;
  /** Fallback value to return on error */
  fallback?: any;
  /** Additional metadata to include in error logs */
  meta?: Record<string, any>;
}

/**
 * Wraps an async function with error handling
 * 
 * @example
 * const safeFetch = withErrorHandling(
 *   async (url) => fetch(url),
 *   { component: 'api-client', message: 'Failed to fetch', rethrow: true }
 * );
 */
export function withErrorHandling<TArgs extends any[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options: ErrorHandlerOptions,
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    try {
      return await fn(...args);
    } catch (error) {
      if (!options.silent) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const logMessage = options.message || "Operation failed";
        
        logger.error(options.component, logMessage, error instanceof Error ? error : undefined, {
          ...options.meta,
          errorMessage,
        });
      }

      if (options.rethrow) {
        throw error;
      }

      if (options.fallback !== undefined) {
        return options.fallback;
      }

      throw error;
    }
  };
}

/**
 * Wraps a synchronous function with error handling
 * 
 * @example
 * const safeParseJSON = withErrorHandlingSync(
 *   (text) => JSON.parse(text),
 *   { component: 'parser', message: 'Failed to parse JSON', fallback: {} }
 * );
 */
export function withErrorHandlingSync<TArgs extends any[], TReturn>(
  fn: (...args: TArgs) => TReturn,
  options: ErrorHandlerOptions,
): (...args: TArgs) => TReturn {
  return (...args: TArgs): TReturn => {
    try {
      return fn(...args);
    } catch (error) {
      if (!options.silent) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const logMessage = options.message || "Operation failed";
        
        logger.error(options.component, logMessage, error instanceof Error ? error : undefined, {
          ...options.meta,
          errorMessage,
        });
      }

      if (options.rethrow) {
        throw error;
      }

      if (options.fallback !== undefined) {
        return options.fallback;
      }

      throw error;
    }
  };
}

/**
 * Method decorator for class methods (async)
 * 
 * @example
 * class MyService {
 *   @withErrorHandlingDecorator({ component: 'MyService', message: 'Method failed' })
 *   async fetchData() {
 *     // method implementation
 *   }
 * }
 */
export function withErrorHandlingDecorator(options: ErrorHandlerOptions) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const originalMethod = descriptor.value;

    if (typeof originalMethod !== "function") {
      throw new Error("@withErrorHandlingDecorator can only be applied to methods");
    }

    descriptor.value = async function (...args: any[]) {
      try {
        return await originalMethod.apply(this, args);
      } catch (error) {
        if (!options.silent) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const logMessage = options.message || `${propertyKey} failed`;
          
          logger.error(options.component, logMessage, error instanceof Error ? error : undefined, {
            ...options.meta,
            method: propertyKey,
            errorMessage,
          });
        }

        if (options.rethrow) {
          throw error;
        }

        if (options.fallback !== undefined) {
          return options.fallback;
        }

        throw error;
      }
    };

    return descriptor;
  };
}

/**
 * Utility to safely execute a function and return [error, result] tuple
 * Useful for avoiding try-catch blocks in simple cases
 * 
 * @example
 * const [error, data] = await safe(fetchUser(id));
 * if (error) {
 *   // handle error
 * } else {
 *   // use data
 * }
 */
export async function safe<T>(
  promise: Promise<T>,
): Promise<[Error | null, T | undefined]> {
  try {
    const result = await promise;
    return [null, result];
  } catch (error) {
    return [error instanceof Error ? error : new Error(String(error)), undefined];
  }
}

/**
 * Synchronous version of safe()
 */
export function safeSync<T>(fn: () => T): [Error | null, T | undefined] {
  try {
    const result = fn();
    return [null, result];
  } catch (error) {
    return [error instanceof Error ? error : new Error(String(error)), undefined];
  }
}
