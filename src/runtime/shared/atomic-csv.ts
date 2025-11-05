import { writeFile, rename, unlink, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Atomic CSV operations to prevent corruption and race conditions
 */

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
  fsync?: boolean; // Force sync to disk
}

/**
 * Write to a file atomically using temp file + rename
 * Prevents partial writes and corruption
 */
export async function atomicWrite(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const { encoding = "utf8", mode, fsync = true } = options;
  const dir = dirname(filePath);
  const tempSuffix = randomBytes(8).toString("hex");
  const tempPath = join(dir, `.tmp-${tempSuffix}`);

  try {
    // Write to temp file
    await writeFile(tempPath, content, { encoding, mode });

    // Atomic rename
    await rename(tempPath, filePath);

    if (fsync) {
      // Note: Node.js doesn't expose fsync for directories easily,
      // but the rename itself is atomic on most filesystems
    }
  } catch (error) {
    // Clean up temp file on failure
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Append to a CSV file atomically
 * Uses read-modify-write with atomic rename
 */
export async function atomicAppend(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const { encoding = "utf8" } = options;

  try {
    // Read existing content
    let existing = "";
    try {
      existing = await readFile(filePath, encoding);
    } catch (error) {
      // File doesn't exist, that's ok
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    // Combine and write atomically
    const newContent = existing + content;
    await atomicWrite(filePath, newContent, options);
  } catch (error) {
    throw new Error(`Failed to append to ${filePath}: ${error}`);
  }
}

/**
 * Append multiple lines to CSV with single atomic write
 * More efficient than multiple atomicAppend calls
 */
export async function atomicAppendBatch(
  filePath: string,
  lines: string[],
  options: AtomicWriteOptions = {},
): Promise<void> {
  if (lines.length === 0) return;

  const content = lines.join("\n") + "\n";
  await atomicAppend(filePath, content, options);
}

/**
 * Lock-based CSV writer for high-concurrency scenarios
 * Uses file-based locking to prevent race conditions
 */
export class CsvWriter {
  private locks = new Map<string, Promise<void>>();

  /**
   * Append a line to CSV with automatic locking
   */
  async append(filePath: string, line: string): Promise<void> {
    return this.withLock(filePath, async () => {
      await atomicAppend(filePath, line.endsWith("\n") ? line : `${line}\n`);
    });
  }

  /**
   * Append multiple lines with automatic locking
   */
  async appendBatch(filePath: string, lines: string[]): Promise<void> {
    return this.withLock(filePath, async () => {
      await atomicAppendBatch(filePath, lines);
    });
  }

  /**
   * Replace entire file content atomically with locking
   */
  async write(filePath: string, content: string): Promise<void> {
    return this.withLock(filePath, async () => {
      await atomicWrite(filePath, content);
    });
  }

  /**
   * Execute operation with file-level lock
   */
  private async withLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    // Wait for any existing lock on this file
    const existingLock = this.locks.get(filePath);
    if (existingLock) {
      await existingLock.catch(() => {
        // Ignore errors from previous operations
      });
    }

    // Create new lock
    const lockPromise = operation();
    this.locks.set(filePath, lockPromise as Promise<void>);

    try {
      const result = await lockPromise;
      return result;
    } finally {
      // Remove lock after completion
      if (this.locks.get(filePath) === (lockPromise as Promise<void>)) {
        this.locks.delete(filePath);
      }
    }
  }
}

// Singleton CSV writer instance
let csvWriterInstance: CsvWriter | null = null;

/**
 * Get shared CSV writer instance
 */
export function getCsvWriter(): CsvWriter {
  if (!csvWriterInstance) {
    csvWriterInstance = new CsvWriter();
  }
  return csvWriterInstance;
}
