import { createHash } from "node:crypto";

const DEFAULT_DIMENSIONS = 48;

export function normalizeQuestion(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function hashQuestion(raw: string): string {
  const normalized = normalizeQuestion(raw);
  return createHash("sha256").update(normalized).digest("hex");
}

export function embedQuestion(raw: string, dimensions = DEFAULT_DIMENSIONS): number[] {
  const normalized = normalizeQuestion(raw);
  const vector = new Array(dimensions).fill(0) as number[];

  for (let index = 0; index < normalized.length; index += 1) {
    const charCode = normalized.charCodeAt(index) ?? 0;
    const bucket = charCode % dimensions;
    const value = (charCode % 997) / 997; // pseudo-random but deterministic weight
    vector[bucket] += value;
  }

  return normalizeVector(vector);
}

export function cosineSimilarity(a?: number[] | null, b?: number[] | null): number {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) {
    return -1;
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }

  if (magA === 0 || magB === 0) {
    return -1;
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

export function parseEmbedding(value: unknown): number[] | null {
  if (!value) {
    return null;
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
    return value as number[];
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "number")) {
        return parsed as number[];
      }
    } catch {
      return null;
    }
  }

  if (typeof value === "object") {
    try {
      const serialized = JSON.parse(JSON.stringify(value));
      if (Array.isArray(serialized) && serialized.every((entry: unknown) => typeof entry === "number")) {
        return serialized as number[];
      }
    } catch {
      return null;
    }
  }

  return null;
}
