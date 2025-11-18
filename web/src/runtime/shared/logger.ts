/**
 * Structured Logger
 * 
 * Provides consistent, structured logging with automatic PII masking
 * and configurable log levels.
 */

import { PIIMasker } from "./pii-masker";

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

type LogMode = "json" | "compact" | "silent";

interface LogEntry {
  level: LogLevel;
  component: string;
  message: string;
  timestamp: number;
  meta?: Record<string, any>;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}

class Logger {
  private readonly minLevel: LogLevel;
  private readonly maskPII: boolean;
  private readonly logMode: LogMode;

  constructor() {
    this.logMode = this.resolveLogMode(process.env.MILL_LOG_MODE);
    const defaultLevel = this.logMode === 'compact' ? 'warn' : 'info';
    this.minLevel = this.parseLogLevel(process.env.LOG_LEVEL || defaultLevel);
    this.maskPII = process.env.MASK_PII !== 'false'; // Default to true
  }

  private resolveLogMode(value: string | undefined): LogMode {
    const normalized = value?.toLowerCase();

    if (normalized === 'compact' || normalized === 'silent') {
      return normalized;
    }

    return 'json';
  }

  private parseLogLevel(level: string): LogLevel {
    const normalized = level.toLowerCase();
    if (normalized in LogLevel) {
      return normalized as LogLevel;
    }
    return LogLevel.INFO;
  }

  private shouldLog(level: LogLevel): boolean {
    if (this.logMode === 'silent') {
      return false;
    }

    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    const currentIndex = levels.indexOf(level);
    const minIndex = levels.indexOf(this.minLevel);
    return currentIndex >= minIndex;
  }

  private formatEntry(entry: LogEntry): string {
    if (this.logMode === 'compact') {
      return this.formatCompact(entry);
    }

    const formatted: any = {
      level: entry.level,
      component: entry.component,
      message: entry.message,
      timestamp: new Date(entry.timestamp).toISOString(),
    };

    if (entry.meta) {
      formatted.meta = this.sanitizeMeta(entry.meta);
    }

    if (entry.error) {
      formatted.error = entry.error;
    }

    return JSON.stringify(formatted);
  }

  private formatCompact(entry: LogEntry): string {
    const parts: string[] = [`[${entry.component}]`, entry.message];

    if (entry.error?.message) {
      parts.push(`(${entry.error.message})`);
    }

    if (entry.meta) {
      const sanitized = this.sanitizeMeta(entry.meta);
      if (Object.keys(sanitized).length > 0) {
        parts.push(JSON.stringify(sanitized));
      }
    }

    return parts.join(' ');
  }

  private sanitizeMeta(meta: Record<string, any>): Record<string, any> {
    return this.maskPII ? PIIMasker.createSafeLogObject(meta) : meta;
  }

  private write(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) {
      return;
    }

    const formatted = this.formatEntry(entry);

    switch (entry.level) {
      case LogLevel.ERROR:
        console.error(formatted);
        break;
      case LogLevel.WARN:
        console.warn(formatted);
        break;
      case LogLevel.DEBUG:
      case LogLevel.INFO:
      default:
        console.log(formatted);
        break;
    }
  }

  /**
   * Log debug-level message (development only)
   */
  debug(component: string, message: string, meta?: Record<string, any>): void {
    this.write({
      level: LogLevel.DEBUG,
      component,
      message,
      timestamp: Date.now(),
      ...(meta && { meta }),
    });
  }

  /**
   * Log info-level message
   */
  info(component: string, message: string, meta?: Record<string, any>): void {
    this.write({
      level: LogLevel.INFO,
      component,
      message,
      timestamp: Date.now(),
      ...(meta && { meta }),
    });
  }

  /**
   * Log warning message
   */
  warn(component: string, message: string, meta?: Record<string, any>): void {
    this.write({
      level: LogLevel.WARN,
      component,
      message,
      timestamp: Date.now(),
      ...(meta && { meta }),
    });
  }

  /**
   * Log error message
   */
  error(component: string, message: string, error: Error | unknown, meta?: Record<string, any>): void {
    const errorInfo: { message: string; stack?: string; code?: string } = error instanceof Error
      ? {
          message: error.message,
          ...(error.stack && { stack: error.stack }),
          ...((error as any).code && { code: (error as any).code }),
        }
      : {
          message: String(error),
        };

    this.write({
      level: LogLevel.ERROR,
      component,
      message,
      timestamp: Date.now(),
      error: errorInfo,
      ...(meta && { meta }),
    });
  }

  /**
   * Create a child logger with fixed component name
   */
  forComponent(component: string): ComponentLogger {
    return new ComponentLogger(this, component);
  }
}

/**
 * Component-scoped logger for convenience
 */
class ComponentLogger {
  constructor(
    private readonly parent: Logger,
    private readonly component: string,
  ) {}

  debug(message: string, meta?: Record<string, any>): void {
    this.parent.debug(this.component, message, meta);
  }

  info(message: string, meta?: Record<string, any>): void {
    this.parent.info(this.component, message, meta);
  }

  warn(message: string, meta?: Record<string, any>): void {
    this.parent.warn(this.component, message, meta);
  }

  error(message: string, error: Error | unknown, meta?: Record<string, any>): void {
    this.parent.error(this.component, message, error, meta);
  }
}

// Export singleton instance
export const logger = new Logger();

// Export component-specific loggers for common modules
export const devLogger = logger.forComponent('dev-agent');
export const smsLogger = logger.forComponent('dev-sms');
export const parserLogger = logger.forComponent('dev-llm-parser');
export const alertLogger = logger.forComponent('alert-manager');
export const paramLogger = logger.forComponent('param-analyst');
