/**
 * Factual Answer Tool using DuckDuckGo Instant Answer API
 * 
 * Provides FACTUAL instant answers for:
 * - Definitions: "What is compound interest?"
 * - Calculations: "15% of 5000"
 * - Facts: "inflation rate India"
 * - Entities: "Zerodha company info"
 * - Conversions: "1 USD to INR"
 * 
 * NOT suitable for:
 * - General web search ("best budgeting tips")
 * - How-to guides ("how to save money")
 * - Opinion content ("best app for...")
 * - Recent news/articles
 * 
 * No API key required - completely free!
 */

import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolDefinition } from "../agents/types.js";

export const webSearchToolDefinition: ToolDefinition = {
  name: "get_factual_answer",
  description:
    "Get FACTUAL instant answers for definitions, calculations, conversions, and entity information. Examples: 'What is compound interest?', '15% of 5000', '1 USD to INR', 'inflation rate India', 'Zerodha company'. NOT for how-to guides or general advice.",
  parameters: [
    {
      name: "query",
      type: "string",
      description: "The factual query (e.g., 'What is SIP investment?', '20% of 10000', 'GST rate India')",
      required: true,
    },
    {
      name: "maxResults",
      type: "number",
      description: "Maximum number of results to return (default: 5)",
      required: false,
    },
  ],
};

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
  source?: string;
}

export interface WebSearchResult {
  query: string;
  results: SearchResult[];
  searchTime: string;
  totalResults: number;
}

export type WebSearchExecutor = (query: string, maxResults?: number) => Promise<WebSearchResult>;

/**
 * Create web search tool for AI SDK
 */
export function createWebSearchTool(executor: WebSearchExecutor) {
  const searchSchema = z.object({
    query: z.string().describe("The search query"),
    maxResults: z.number().optional().default(5).describe("Maximum number of results"),
  });

  const createTool = tool as unknown as (options: {
    name: string;
    description: string;
    parameters: typeof searchSchema;
    execute: (params: { query: string; maxResults?: number }) => Promise<WebSearchResult>;
  }) => Tool;

  return createTool({
    name: webSearchToolDefinition.name,
    description: webSearchToolDefinition.description,
    parameters: searchSchema,
    execute: async ({ query, maxResults }) => {
      return executor(query, maxResults);
    },
  });
}

/**
 * DuckDuckGo Instant Answer API - Returns factual information
 * 
 * Works best for:
 * - Definitions: Returns Abstract with explanation
 * - Calculations: Returns Answer with computed result
 * - Facts: Returns Abstract with factual info
 * - Entities: Returns Infobox with structured data
 * 
 * API response structure:
 * - Abstract: Main factual text
 * - Answer: Direct answer (calculations, conversions)
 * - RelatedTopics: Related information
 * - Infobox: Structured entity data
 */
export async function searchDuckDuckGo(
  query: string,
  maxResults: number = 5,
): Promise<WebSearchResult> {
  const startTime = Date.now();
  
  try {
    // DuckDuckGo Instant Answer API
    const response = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    );
    
    if (!response.ok) {
      throw new Error(`DuckDuckGo API error: ${response.statusText}`);
    }
    
    const data = await response.json() as any;
    const results: SearchResult[] = [];
    
    // Priority 1: Direct Answer (calculations, conversions, facts)
    if (data.Answer && data.Answer.trim()) {
      results.push({
        title: "Direct Answer",
        snippet: data.Answer,
        url: data.AbstractURL || "",
        source: "DuckDuckGo Instant Answer",
      });
    }
    
    // Priority 2: Abstract (definitions, explanations)
    if (data.Abstract && data.Abstract.trim()) {
      results.push({
        title: data.Heading || "Definition",
        snippet: data.Abstract,
        url: data.AbstractURL || "",
        source: "DuckDuckGo",
      });
    }
    
    // Priority 3: RelatedTopics (additional context)
    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics.slice(0, Math.min(maxResults - results.length, 5))) {
        if (topic.Text && topic.FirstURL) {
          results.push({
            title: topic.Text.substring(0, 100),
            snippet: topic.Text,
            url: topic.FirstURL,
            source: "DuckDuckGo",
          });
        }
      }
    }
    
    return {
      query,
      results,
      searchTime: `${Date.now() - startTime}ms`,
      totalResults: results.length,
    };
  } catch (error) {
    console.error("[factual-answer] DuckDuckGo search failed:", error);
    return {
      query,
      results: [],
      searchTime: `${Date.now() - startTime}ms`,
      totalResults: 0,
    };
  }
}

/**
 * Google Custom Search implementation (requires API key)
 * Get API key: https://developers.google.com/custom-search/v1/overview
 */
export async function searchGoogle(
  query: string,
  maxResults: number = 5,
  apiKey?: string,
  searchEngineId?: string,
): Promise<WebSearchResult> {
  const startTime = Date.now();
  
  // Check for API credentials
  const key = apiKey || process.env.GOOGLE_SEARCH_API_KEY;
  const cx = searchEngineId || process.env.GOOGLE_SEARCH_ENGINE_ID;
  
  if (!key || !cx) {
    console.warn("[web-search] Google Search API credentials not found, falling back to DuckDuckGo");
    return searchDuckDuckGo(query, maxResults);
  }
  
  try {
    const response = await fetch(
      `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(query)}&num=${maxResults}`
    );
    
    if (!response.ok) {
      throw new Error(`Google Search API error: ${response.statusText}`);
    }
    
    const data = await response.json() as any;
    const results: SearchResult[] = [];
    
    if (data.items && Array.isArray(data.items)) {
      for (const item of data.items) {
        results.push({
          title: item.title,
          snippet: item.snippet || "",
          url: item.link,
          source: "Google",
        });
      }
    }
    
    return {
      query,
      results,
      searchTime: `${Date.now() - startTime}ms`,
      totalResults: parseInt(data.searchInformation?.totalResults || "0", 10),
    };
  } catch (error) {
    console.error("[web-search] Google search failed:", error);
    // Fallback to DuckDuckGo
    return searchDuckDuckGo(query, maxResults);
  }
}

/**
 * Main factual answer function - uses DuckDuckGo Instant Answer API
 * 
 * Best for:
 * - Definitions: "What is mutual fund", "Define compound interest"
 * - Calculations: "15% of 5000", "compound interest formula"
 * - Conversions: "1000 USD to INR", "convert rupees to dollars"
 * - Facts: "inflation rate India 2024", "GST rate"
 * - Company info: "Zerodha company", "Paytm founded when"
 * 
 * Returns instant answer if available, otherwise returns related topics
 */
export async function searchWeb(
  query: string,
  maxResults: number = 5,
  preferredProvider: "duckduckgo" | "google" = "duckduckgo",
): Promise<WebSearchResult> {
  console.log(`[factual-answer] Searching for: "${query}"`);
  
  // Only DuckDuckGo supported for factual answers (no API key needed)
  if (preferredProvider === "google") {
    console.log(`[factual-answer] Note: Google search not implemented. Using DuckDuckGo for factual answers.`);
  }
  
  return searchDuckDuckGo(query, maxResults);
}

/**
 * Format search results for display
 */
export function formatSearchResults(searchResult: WebSearchResult): string {
  if (searchResult.results.length === 0) {
    return `No results found for "${searchResult.query}".`;
  }
  
  const lines: string[] = [];
  lines.push(`🔍 Search results for "${searchResult.query}" (${searchResult.totalResults} found):\n`);
  
  searchResult.results.forEach((result, index) => {
    lines.push(`${index + 1}. **${result.title}**`);
    lines.push(`   ${result.snippet}`);
    lines.push(`   🔗 ${result.url}\n`);
  });
  
  return lines.join("\n");
}

/**
 * Extract key insights from search results using simple text analysis
 */
export function extractInsights(searchResult: WebSearchResult, focusArea?: string): string {
  if (searchResult.results.length === 0) {
    return "No insights available - no search results found.";
  }
  
  const allText = searchResult.results
    .map(r => `${r.title} ${r.snippet}`)
    .join(" ")
    .toLowerCase();
  
  // Simple keyword-based insight extraction
  const insights: string[] = [];
  
  // Financial keywords
  if (allText.includes("budget") || allText.includes("budgeting")) {
    insights.push("💡 Budgeting is mentioned frequently - consider creating a monthly budget");
  }
  
  if (allText.includes("save") || allText.includes("saving")) {
    insights.push("💡 Saving strategies are highlighted - focus on building an emergency fund");
  }
  
  if (allText.includes("track") || allText.includes("tracking")) {
    insights.push("💡 Expense tracking is recommended - consistent logging helps awareness");
  }
  
  if (allText.includes("emergency fund") || allText.includes("emergency")) {
    insights.push("💡 Emergency funds are emphasized - aim for 3-6 months of expenses");
  }
  
  if (allText.includes("50/30/20") || allText.includes("50-30-20")) {
    insights.push("💡 The 50/30/20 rule appears: 50% needs, 30% wants, 20% savings");
  }
  
  if (insights.length === 0) {
    insights.push("💡 Various financial strategies mentioned - review the results for details");
  }
  
  return insights.join("\n");
}

/**
 * Helper: Get factual answer for financial terms/concepts
 * 
 * Examples:
 * - "SIP investment" → "What is SIP investment?"
 * - "compound interest" → "compound interest formula"
 * - "GST rate" → "GST rate India"
 */
export async function searchFinancialAdvice(topic: string): Promise<{
  results: WebSearchResult;
  insights: string;
  summary: string;
}> {
  const query = `what is ${topic} financial definition`;
  const results = await searchWeb(query, 5);
  const insights = extractInsights(results, topic);
  
  let summary = "";
  if (results.results.length > 0) {
    const firstResult = results.results[0];
    if (firstResult) {
      summary = `📚 Factual answer for "${topic}":\n\n${firstResult.snippet.substring(0, 300)}...`;
    }
  } else {
    summary = `No factual answer found for "${topic}". Try queries like "What is ${topic}?" or "Define ${topic}".`;
  }
  
  return { results, insights, summary };
}
