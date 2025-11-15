/**
 * Grounded policy/tax search tool wrapper.
 *
 * This tool delegates factual/policy lookups to an external grounding provider
 * (Vercel ai-sdk-preview-rag, Google Grounding, OpenAI grounded generation, etc.)
 * and returns structured snippets with citations. No documents are stored locally.
 */

import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolDefinition } from "../agents/types.js";
import {
  DEFAULT_MAX_SNIPPETS,
  GOV_PRIORITY_DOMAINS,
  MAX_ALLOWED_SNIPPETS,
  performSerpGroundedSearch,
  sanitizeQuery,
} from "./grounded-search-shared.js";
import type {
  GroundedSearchExecutor,
  GroundedSearchInput,
  GroundedSearchResult,
  GroundedSearchSnippet,
} from "./grounded-search-shared.js";

export {
  DEFAULT_MAX_SNIPPETS,
  GOV_PRIORITY_DOMAINS,
  MAX_ALLOWED_SNIPPETS,
  performSerpGroundedSearch,
  sanitizeQuery,
} from "./grounded-search-shared.js";

export type {
  GroundedSearchExecutor,
  GroundedSearchInput,
  GroundedSearchResult,
  GroundedSearchSnippet,
  GroundingIntent,
} from "./grounded-search-shared.js";

function buildSourceLabel(snippet: GroundedSearchSnippet): string | undefined {
  if (snippet.source) {
    return snippet.source;
  }
  if (snippet.url) {
    return safeHostname(snippet.url);
  }
  return undefined;
}

function formatSnippetLine(snippet: GroundedSearchSnippet, index: number): string {
  const title = snippet.title ?? "Authoritative Source";
  const summary = snippet.snippet.trim();
  const sourceLabel = buildSourceLabel(snippet);
  const citation = sourceLabel ? `Source: ${sourceLabel}` : undefined;
  const link = snippet.url ? ` (${snippet.url})` : "";
  const prefix = `${index + 1}. ${title}:`;
  const details = summary.length > 0 ? ` ${summary}` : "";
  const citationFragment = citation ? ` — ${citation}` : "";
  return `${prefix}${details}${citationFragment}${link}`;
}

export function formatGroundedSearchResults(result: GroundedSearchResult): string {
  const providerLabel = result.provider ? ` via ${result.provider}` : "";
  const header = `🔎 Grounded search${providerLabel} for "${result.query}"`;

  if (result.snippets.length === 0) {
    const reason = result.error ?? result.note;
    const tail = reason ? ` — ${reason}` : "";
    return `${header}: No authoritative source showed up${tail ? tail : "."}`;
  }

  const lines = result.snippets.map((snippet, index) => `  • ${formatSnippetLine(snippet, index)}`);
  return `${header}:
${lines.join("\n")}`;
}

export const groundedSearchToolDefinition: ToolDefinition = {
  name: "search_with_sources",
  description:
    "Look up authoritative tax, policy, regulatory, RBI/SEBI/GST facts using the external grounding provider. Always cite returned sources. Fallback with 'No authoritative source found' when snippets are empty.",
  parameters: [
    {
      name: "query",
      type: "string",
      description:
        "Short sanitized query (2-8 keywords) describing the fact/policy needed. Example: 'latest rbi repo rate', 'income tax new regime slabs 2025'.",
      required: true,
    },
    {
      name: "intent",
      type: "enum",
      description:
        "Optional intent bucket so the provider can bias retrieval. Use 'tax', 'policy', 'regulation', 'market', or 'finance_fact'.",
      required: false,
    },
    {
      name: "maxSnippets",
      type: "number",
      description: "Maximum number of grounded snippets to return (default 3).",
      required: false,
    },
    {
      name: "freshnessDays",
      type: "number",
      description: "Maximum age (days) for documents. Leave blank to accept provider defaults.",
      required: false,
    },
    {
      name: "domainFilter",
      type: "object",
      description: "Optional list of allowed domains (e.g., ['rbi.org.in','incometaxindia.gov.in']).",
      required: false,
    },
  ],
};


/**
 * Create the AI SDK tool wrapper for grounded search.
 */
export function createGroundedSearchTool(executor: GroundedSearchExecutor) {
  const parameterSchema = z.object({
    query: z
      .string()
      .min(3, "Query must include at least 3 characters")
      .max(256, "Query too long")
      .describe("Short sanitized query (2-8 keywords) describing the fact/policy needed."),
    intent: z
      .enum(["tax", "policy", "regulation", "market", "finance_fact"] as const)
      .optional()
      .describe("Optional hint for provider routing."),
    maxSnippets: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .default(3)
      .describe("Maximum snippets to return (default 3)."),
    freshnessDays: z
      .number()
      .int()
      .min(0)
      .max(365)
      .optional()
      .describe("Optional freshness limit in days."),
    domainFilter: z
      .array(z.string().url().or(z.string()))
      .optional()
      .describe("Whitelist of source domains (optional)."),
  });

  const createTool = tool as unknown as (options: {
    name: string;
    description: string;
    parameters: typeof parameterSchema;
    execute: (params: GroundedSearchInput) => Promise<GroundedSearchResult>;
  }) => Tool;

  return createTool({
    name: groundedSearchToolDefinition.name,
    description: groundedSearchToolDefinition.description,
    parameters: parameterSchema,
    execute: executor,
  });
}

const DEFAULT_APP_BASE_URL = "http://localhost:3000";
const DEFAULT_GROUNDED_SEARCH_PATH = "/api/grounded-search";
type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  if (typeof value === "object" && value !== null) {
    return value as UnknownRecord;
  }
  return {};
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function normalizeSnippets(payload: unknown, limit: number): GroundedSearchSnippet[] {
  const record = asRecord(payload);
  const rawCollections = [record.snippets, record.documents, record.results, record.citations]
    .map((value) => (Array.isArray(value) ? value : null))
    .filter((collection): collection is unknown[] => Array.isArray(collection));

  if (rawCollections.length === 0) {
    return [];
  }

  const normalized: GroundedSearchSnippet[] = [];
  for (const collection of rawCollections) {
    for (const rawValue of collection) {
      const rawRecord = asRecord(rawValue);

      const snippetText =
        optionalString(rawRecord.snippet) ??
        optionalString(rawRecord.summary) ??
        optionalString(rawRecord.content) ??
        "";

      if (!snippetText) {
        continue;
      }

      const url =
        optionalString(rawRecord.url) ??
        optionalString(rawRecord.link) ??
        optionalString(rawRecord.sourceUrl) ??
        "";
      const title =
        optionalString(rawRecord.title) ??
        optionalString(rawRecord.headline) ??
        optionalString(rawRecord.source) ??
        "Authoritative Source";
      const source = optionalString(rawRecord.source) ?? optionalString(rawRecord.publisher) ?? (url ? safeHostname(url) : undefined);
      const publishedAt =
        optionalString(rawRecord.publishedAt) ??
        optionalString(rawRecord.date) ??
        optionalString(rawRecord.timestamp);
      const confidence = optionalNumber(rawRecord.confidence) ?? optionalNumber(rawRecord.score);
      const provider = optionalString(rawRecord.provider);

      const snippet: GroundedSearchSnippet = {
        title,
        snippet: snippetText,
        url,
      };

      if (source) {
        snippet.source = source;
      }

      if (publishedAt) {
        snippet.publishedAt = publishedAt;
      }

      if (typeof confidence === "number") {
        snippet.confidence = confidence;
      }

      if (provider) {
        snippet.provider = provider;
      }

      normalized.push(snippet);

      if (normalized.length >= limit) {
        return normalized;
      }
    }
  }

  return normalized.slice(0, limit);
}

function safeHostname(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export interface GroundingProviderOptions {
  signal?: AbortSignal;
}

/**
 * Helper to call the configured external grounding provider.
 */
export async function callGroundedSearchProvider(
  input: GroundedSearchInput,
  options: GroundingProviderOptions = {},
): Promise<GroundedSearchResult> {
  const providerName = process.env.GROUNDED_SEARCH_PROVIDER ?? "external";
  const endpoint = resolveGroundedSearchEndpoint();
  const apiKey = process.env.GROUNDED_SEARCH_API_KEY;
  const serviceToken = process.env.SERVICE_API_TOKEN;
  const serpApiKey = optionalString(process.env.GROUNDED_SEARCH_SERPAPI_KEY) ?? optionalString(process.env.SERPAPI_KEY);
  const sanitizedQuery = sanitizeQuery(input.query);
  const requestedSnippets =
    typeof input.maxSnippets === "number" && Number.isFinite(input.maxSnippets)
      ? input.maxSnippets
      : DEFAULT_MAX_SNIPPETS;
  const maxSnippets = clamp(requestedSnippets, 1, MAX_ALLOWED_SNIPPETS);
  const start = Date.now();

  const runSerpFallback = async (): Promise<GroundedSearchResult> => {
    if (!serpApiKey) {
      return {
        query: input.query,
        sanitizedQuery,
        provider: "serpapi",
        latencyMs: Date.now() - start,
        snippets: [],
        error: "SERPAPI_KEY_MISSING",
        note: "Set SERPAPI_KEY or GROUNDED_SEARCH_SERPAPI_KEY to enable direct SerpAPI search.",
      };
    }

    try {
      const serpResult = await performSerpGroundedSearch(
        { ...input, maxSnippets },
        {
        apiKey: serpApiKey,
        prioritizedDomains:
          Array.isArray(input.domainFilter) && input.domainFilter.length > 0
            ? input.domainFilter
            : GOV_PRIORITY_DOMAINS,
        allowAnyDomain: !Array.isArray(input.domainFilter) || input.domainFilter.length === 0,
        },
      );

      const directResult: GroundedSearchResult = {
        query: input.query,
        sanitizedQuery: serpResult.sanitizedQuery,
        provider: serpResult.provider,
        latencyMs: Date.now() - start,
        snippets: serpResult.snippets,
      };

      if (serpResult.note) {
        directResult.note = serpResult.note;
      }

      return directResult;
    } catch (serpError) {
      const message = serpError instanceof Error ? serpError.message : String(serpError);
      console.error("[grounded-search] direct SerpAPI search failed:", message);
      return {
        query: input.query,
        sanitizedQuery,
        provider: "serpapi",
        latencyMs: Date.now() - start,
        snippets: [],
        error: message,
      };
    }
  };

  if (!endpoint && !serpApiKey) {
    return {
      query: input.query,
      sanitizedQuery,
      provider: providerName,
      latencyMs: Date.now() - start,
      snippets: [],
      error: "GROUNDING_ENDPOINT_MISSING",
      note: "Set GROUNDED_SEARCH_API_URL to enable external grounding.",
    };
  }

  if (!endpoint && serpApiKey) {
    return runSerpFallback();
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const resolvedAuth = resolveAuthHeader(apiKey, serviceToken);
  if (resolvedAuth) {
    headers.Authorization = resolvedAuth;
  }

  const body = JSON.stringify({
    query: sanitizedQuery,
    intent: input.intent,
    maxSnippets,
    freshnessDays: input.freshnessDays,
    domainFilter: input.domainFilter,
  });

  const callExternalProvider = async (): Promise<GroundedSearchResult> => {
    if (!endpoint) {
      throw new Error("GROUNDING_ENDPOINT_MISSING");
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: options.signal ?? null,
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(`Grounding provider error ${response.status}: ${details || response.statusText}`);
    }

  const payloadRecord = asRecord(await response.json().catch(() => ({})));
    const snippets = normalizeSnippets(payloadRecord, maxSnippets);
    const noSnippets = snippets.length === 0;
    const note = optionalString(payloadRecord.note);
    const meta = asRecord(payloadRecord.meta);
    const providerLabel = optionalString(payloadRecord.provider) ?? providerName;
    const cachedFlag = Boolean(
      optionalBoolean(payloadRecord.cached) ?? optionalBoolean(meta.cached) ?? false,
    );

    const result: GroundedSearchResult = {
      query: input.query,
      sanitizedQuery,
      provider: providerLabel,
      latencyMs: Date.now() - start,
      cached: cachedFlag,
      snippets,
    };

    if (note) {
      result.note = note;
    }

    if (noSnippets) {
      result.error = "NO_SNIPPETS";
    }

    return result;
  };

  try {
    const externalResult = await callExternalProvider();
    if (externalResult.snippets.length === 0 && serpApiKey) {
      const fallbackResult = await runSerpFallback();
      if (fallbackResult.snippets.length > 0) {
        return fallbackResult;
      }
    }
    return externalResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[grounded-search] provider call failed:", message);

    if (serpApiKey) {
      return runSerpFallback();
    }

    return {
      query: input.query,
      sanitizedQuery,
      provider: providerName,
      latencyMs: Date.now() - start,
      snippets: [],
      error: message,
    };
  }
}

function resolveGroundedSearchEndpoint(): string | undefined {
  const direct = optionalString(process.env.GROUNDED_SEARCH_API_URL);
  if (direct) {
    return direct;
  }

  const base = optionalString(process.env.MILL_API_BASE_URL) ?? DEFAULT_APP_BASE_URL;
  const path = optionalString(process.env.GROUNDED_SEARCH_API_PATH) ?? DEFAULT_GROUNDED_SEARCH_PATH;

  try {
    return new URL(path, base).toString();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[grounded-search] Failed to build endpoint:", message);
    return undefined;
  }
}

function resolveAuthHeader(
  apiKey?: string,
  serviceToken?: string,
): string | undefined {
  const token = optionalString(apiKey) ?? optionalString(serviceToken);
  if (!token) {
    return undefined;
  }

  if (token.startsWith("Bearer ")) {
    return token;
  }

  return `Bearer ${token}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
