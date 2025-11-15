import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_MAX_SNIPPETS,
  GOV_PRIORITY_DOMAINS,
  MAX_ALLOWED_SNIPPETS,
  performSerpGroundedSearch,
  type GroundedSearchInput,
  type GroundingIntent,
} from "convo-check/src/tools/grounded-search-shared";

type GroundedSearchRequest = Omit<GroundedSearchInput, "query"> & {
  query: string;
};

const VALID_INTENTS = new Set<GroundingIntent>(["tax", "policy", "regulation", "market", "finance_fact"]);

export async function POST(request: NextRequest) {
  try {
    const payload = (await request.json().catch(() => null)) as GroundedSearchRequest | null;

    if (!payload || typeof payload.query !== "string" || payload.query.trim().length === 0) {
      return NextResponse.json(
        { error: "invalid_request", message: "Expected JSON body with non-empty 'query'" },
        { status: 400 },
      );
    }

    const apiKey = process.env.GROUNDED_SEARCH_SERPAPI_KEY ?? process.env.SERPAPI_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "missing_api_key", message: "SERPAPI_KEY or GROUNDED_SEARCH_SERPAPI_KEY is required" },
        { status: 500 },
      );
    }

    const domainFilter = normalizeDomainFilter(payload.domainFilter);
    const intent = parseIntent(payload.intent);
    const maxSnippets = clampSnippets(payload.maxSnippets);
    const freshnessDays = normalizeNumber(payload.freshnessDays);

    const result = await performSerpGroundedSearch(
      {
        query: payload.query,
        intent,
        maxSnippets: maxSnippets ?? DEFAULT_MAX_SNIPPETS,
        freshnessDays,
        domainFilter: domainFilter.length > 0 ? domainFilter : undefined,
      },
      {
        apiKey,
        prioritizedDomains: domainFilter.length > 0 ? domainFilter : GOV_PRIORITY_DOMAINS,
        allowAnyDomain: domainFilter.length === 0,
      },
    );

    return NextResponse.json({
      provider: result.provider,
      cached: false,
      query: result.sanitizedQuery,
      note: result.note,
      snippets: result.snippets,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "server_error", message }, { status: 500 });
  }
}

function parseIntent(intent?: string): GroundingIntent | undefined {
  if (typeof intent !== "string" || intent.trim().length === 0) {
    return undefined;
  }
  const normalized = intent.trim().toLowerCase() as GroundingIntent;
  return VALID_INTENTS.has(normalized) ? normalized : undefined;
}

function clampSnippets(value?: number): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  const intValue = Math.trunc(value);
  if (intValue <= 0) {
    return 1;
  }
  return Math.min(intValue, MAX_ALLOWED_SNIPPETS);
}

function normalizeDomainFilter(domains?: string[]): string[] {
  if (!Array.isArray(domains)) {
    return [];
  }
  return domains
    .map((domain) => (typeof domain === "string" ? domain.trim() : ""))
    .filter((domain) => domain.length > 0);
}

function normalizeNumber(value?: number): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  return value;
}
