export type GroundingIntent =
  | "tax"
  | "policy"
  | "regulation"
  | "market"
  | "finance_fact";

export interface GroundedSearchInput {
  query: string;
  intent?: GroundingIntent;
  maxSnippets?: number;
  freshnessDays?: number;
  domainFilter?: string[];
}

export interface GroundedSearchSnippet {
  title: string;
  snippet: string;
  url: string;
  source?: string;
  publishedAt?: string;
  confidence?: number;
  provider?: string;
}

export interface GroundedSearchResult {
  query: string;
  sanitizedQuery: string;
  provider: string;
  latencyMs: number;
  snippets: GroundedSearchSnippet[];
  cached?: boolean;
  note?: string;
  error?: string;
}

export type GroundedSearchExecutor = (input: GroundedSearchInput) => Promise<GroundedSearchResult>;

export const SENSITIVE_TOKEN_REGEX = /(acc(?:ount)?|card|ifsc|upi|mobile|phone|pan)[\s:=]*[a-z0-9@._-]+/gi;

export const DEFAULT_MAX_SNIPPETS = 4;
export const MAX_ALLOWED_SNIPPETS = 8;
export const GOV_PRIORITY_DOMAINS = [
  "incometaxindia.gov.in",
  "rbidocs.rbi.org.in",
  "rbi.org.in",
  "egazette.nic.in",
  "pib.gov.in",
  "gst.gov.in",
  "cbic.gov.in",
  "financialservices.gov.in",
  "dea.gov.in",
];

export interface SerpGroundedSearchConfig {
  apiKey: string;
  prioritizedDomains?: string[];
  allowAnyDomain?: boolean;
  fetchImpl?: typeof fetch;
}

export function sanitizeQuery(query: string): string {
  return query
    .trim()
    .replace(/\s+/g, " ")
    .replace(SENSITIVE_TOKEN_REGEX, "[redacted]");
}

type UnknownRecord = Record<string, unknown>;

export async function performSerpGroundedSearch(
  input: GroundedSearchInput,
  config: SerpGroundedSearchConfig,
): Promise<{ query: string; sanitizedQuery: string; provider: string; snippets: GroundedSearchSnippet[]; note?: string }>
{
  if (!config.apiKey) {
    throw new Error("SERPAPI key is required for grounded search");
  }

  const sanitizedQuery = sanitizeQuery(input.query);
  const domainFilter = normalizeDomainFilter(input.domainFilter);
  const prioritizedDomains =
    domainFilter.length > 0
      ? domainFilter
      : config.prioritizedDomains && config.prioritizedDomains.length > 0
        ? config.prioritizedDomains
        : GOV_PRIORITY_DOMAINS;
  const allowAnyDomain = domainFilter.length === 0 ? config.allowAnyDomain !== false : true;
  const maxSnippets = clamp(Number.isFinite(input.maxSnippets) ? Number(input.maxSnippets) : DEFAULT_MAX_SNIPPETS, 1, MAX_ALLOWED_SNIPPETS);
  const queryWithIntent = buildQuery(sanitizedQuery, input.intent, domainFilter);
  const params = buildSerpParams(queryWithIntent, input.freshnessDays, config.apiKey);
  const url = new URL("https://serpapi.com/search.json");
  params.forEach((value, key) => url.searchParams.set(key, value));

  const fetchImpl = config.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    headers: {
      "User-Agent": "ConvoCheck grounded-search/1.0",
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`SerpAPI request failed (${response.status}): ${errorText.slice(0, 200)}`);
  }

  const data = (await response.json().catch(() => null)) as UnknownRecord | null;
  if (!data || typeof data !== "object") {
    throw new Error("SerpAPI response was empty or malformed");
  }

  if (typeof (data as Record<string, unknown>).error === "string") {
    throw new Error(String((data as Record<string, unknown>).error));
  }

  const snippets = extractSnippets(data, {
    maxSnippets,
    prioritizedDomains,
    allowAnyDomain,
  });

  const result: { query: string; sanitizedQuery: string; provider: string; snippets: GroundedSearchSnippet[]; note?: string } = {
    query: input.query,
    sanitizedQuery,
    provider: "serpapi",
    snippets,
  };

  if (snippets.length === 0) {
    result.note = "No authoritative snippets returned";
  }

  return result;
}

function normalizeDomainFilter(domains?: string[]): string[] {
  if (!Array.isArray(domains)) {
    return [];
  }

  return domains
    .map((domain) => (typeof domain === "string" ? domain.trim() : ""))
    .filter((domain) => domain.length > 0);
}

function buildQuery(query: string, intent?: string, domainFilter?: string[]): string {
  const loweredIntent = intent?.toLowerCase();
  let expanded = query;

  if (loweredIntent === "tax" || loweredIntent === "finance_fact") {
    expanded += " site:.gov.in site:gov.in";
  } else if (loweredIntent === "policy" || loweredIntent === "regulation") {
    expanded += " site:gov.in site:nic.in";
  }

  if (Array.isArray(domainFilter) && domainFilter.length > 0) {
    const siteFilters = domainFilter.map((domain) => `site:${domain}`);
    if (siteFilters.length > 0) {
      expanded += ` (${siteFilters.join(" OR ")})`;
    }
  }

  return expanded;
}

function buildSerpParams(query: string, freshnessDays: number | undefined, apiKey: string): Map<string, string> {
  const params = new Map<string, string>();
  params.set("engine", "google");
  params.set("q", query);
  params.set("gl", "in");
  params.set("hl", "en");
  params.set("num", "10");
  params.set("safe", "active");
  params.set("api_key", apiKey);

  const tbs = mapFreshnessToTbs(freshnessDays);
  if (tbs) {
    params.set("tbs", tbs);
  }

  return params;
}

function mapFreshnessToTbs(days?: number): string | undefined {
  if (!days || Number.isNaN(days) || days <= 0) {
    return undefined;
  }

  if (days <= 1) return "qdr:d";
  if (days <= 7) return "qdr:w";
  if (days <= 30) return "qdr:m";
  if (days <= 365) return "qdr:y";
  return undefined;
}

function extractSnippets(
  data: Record<string, unknown>,
  options: { maxSnippets: number; prioritizedDomains: string[]; allowAnyDomain: boolean },
): GroundedSearchSnippet[] {
  const candidates: GroundedSearchSnippet[] = [];

  const organicRaw = (data as { organic_results?: unknown[] }).organic_results;
  const organic = Array.isArray(organicRaw) ? organicRaw : [];
  const newsRaw = (data as { news_results?: unknown[] }).news_results;
  const news = Array.isArray(newsRaw) ? newsRaw : [];
  const answerBox = (data as { answer_box?: unknown }).answer_box ?? null;

  organic.forEach((item) => {
    const snippet = normalizeOrganicResult(item);
    if (snippet) candidates.push(snippet);
  });

  news.forEach((item) => {
    const snippet = normalizeNewsResult(item);
    if (snippet) candidates.push(snippet);
  });

  if (answerBox) {
    const snippet = normalizeAnswerBox(answerBox);
    if (snippet) candidates.push(snippet);
  }

  return candidates
    .map((snippet) => ({
      snippet,
      score: computeScore(snippet, options.prioritizedDomains, options.allowAnyDomain),
    }))
    .filter(({ score }) => score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.maxSnippets)
    .map(({ snippet, score }) => ({ ...snippet, confidence: Number(score.toFixed(2)) }));
}

function normalizeOrganicResult(entry: unknown): GroundedSearchSnippet | null {
  const record = asRecord(entry);
  if (!record) return null;

  const title = getString(record.title);
  const snippet =
    getString(record.snippet) ??
    getRichSnippetExtensions(record.rich_snippet);
  const url = getString(record.link) ?? getString(record.displayed_link);

  if (!title || !snippet || !url) return null;

  const sourceCandidate = getString(record.source);
  const source = sourceCandidate ?? hostnameFromUrl(url);
  const publishedAtValue = getString(record.date);
  const publishedAt = publishedAtValue ? isoDate(publishedAtValue) : undefined;

  const normalized: GroundedSearchSnippet = {
    title,
    snippet,
    url,
    provider: "serpapi",
  };

  if (source) {
    normalized.source = source;
  }

  if (publishedAt) {
    normalized.publishedAt = publishedAt;
  }

  return normalized;
}

function normalizeNewsResult(item: unknown): GroundedSearchSnippet | null {
  const record = asRecord(item);
  if (!record) return null;

  const title = getString(record.title);
  const url = getString(record.link);
  const snippet = getString(record.snippet) ?? getString(record.summary);
  if (!title || !url || !snippet) return null;
  const sourceValue = getString(record.source);
  const source = sourceValue ?? hostnameFromUrl(url);
  const publishedAtValue = getString(record.date);
  const publishedAt = publishedAtValue ? isoDate(publishedAtValue) : undefined;

  const normalized: GroundedSearchSnippet = {
    title,
    snippet,
    url,
    provider: "serpapi_news",
  };

  if (source) {
    normalized.source = source;
  }

  if (publishedAt) {
    normalized.publishedAt = publishedAt;
  }

  return normalized;
}

function normalizeAnswerBox(box: unknown): GroundedSearchSnippet | null {
  const record = asRecord(box);
  if (!record) return null;

  const title = getString(record.title) ?? getString(record.type);
  const snippet = getString(record.answer) ?? joinStringArray(record.answers);
  const url = getString(record.link);
  if (!title || !snippet || !url) return null;
  const source = hostnameFromUrl(url);
  const publishedAtValue = getString(record.date);
  const publishedAt = publishedAtValue ? isoDate(publishedAtValue) : undefined;

  const normalized: GroundedSearchSnippet = {
    title,
    snippet,
    url,
    provider: "serpapi_answer_box",
  };

  if (source) {
    normalized.source = source;
  }

  if (publishedAt) {
    normalized.publishedAt = publishedAt;
  }

  return normalized;
}

function computeScore(snippet: GroundedSearchSnippet, prioritizedDomains: string[], allowAnyDomain: boolean): number {
  let score = 0;
  const host = snippet.source ?? hostnameFromUrl(snippet.url) ?? "";
  const normalizedHost = host.replace(/^www\./, "").toLowerCase();

  if (prioritizedDomains.some((domain) => normalizedHost.endsWith(domain.toLowerCase()))) {
    score += 3;
  }

  if (/\.gov\.in$/.test(normalizedHost) || normalizedHost.endsWith("rbi.org.in")) {
    score += 2;
  }

  if (/\.nic\.in$/.test(normalizedHost) || normalizedHost.endsWith("gov.in")) {
    score += 1.5;
  }

  if (!allowAnyDomain && score === 0) {
    return 0;
  }

  if (snippet.publishedAt) {
    const ageDays = daysSince(snippet.publishedAt);
    if (ageDays !== null) {
      if (ageDays <= 7) score += 1.5;
      else if (ageDays <= 30) score += 1;
      else if (ageDays <= 180) score += 0.5;
    }
  }

  if (snippet.snippet.length > 0) {
    score += Math.min(snippet.snippet.length / 400, 1);
  }

  return score;
}

function hostnameFromUrl(value: string): string | undefined {
  try {
    const host = new URL(value).hostname;
    return host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function isoDate(value: string): string | undefined {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return new Date(parsed).toISOString();
}

function daysSince(value: string): number | null {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  const diff = Date.now() - parsed;
  return diff > 0 ? diff / (1000 * 60 * 60 * 24) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function asRecord(value: unknown): UnknownRecord | null {
  if (value && typeof value === "object") {
    return value as UnknownRecord;
  }
  return null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function joinStringArray(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const fragments = value.filter((segment): segment is string => typeof segment === "string");
  return fragments.length > 0 ? fragments.join(" ") : undefined;
}

function getRichSnippetExtensions(value: unknown): string | undefined {
  const snippetRecord = asRecord(value);
  if (!snippetRecord) {
    return undefined;
  }
  const topRecord = asRecord(snippetRecord.top);
  if (!topRecord) {
    return undefined;
  }
  return joinStringArray(topRecord.extensions);
}
