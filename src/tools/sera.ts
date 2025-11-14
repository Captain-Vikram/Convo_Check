/**
 * Sera Agent Tools - Shopping search and wishlist management utilities.
 * Shared between runtime orchestrators and other entry points.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDefinition } from '../agents/types.js';
import { addToWishlist, getWishlist, type WishlistItem } from '../runtime/sera/wishlist-manager.js';
import { searchAmazonProduct, type AmazonSearchResult } from '../runtime/sera/sera-search.js';
import {
  ShoppingSearchService,
  SearchResultPresenter,
  type SearchResult,
  type ShoppingSearchResponse,
} from '../runtime/sera/services/search-service.js';
import { logger } from '../runtime/shared/logger.js';

export const searchShoppingToolDefinition: ToolDefinition = {
  name: 'searchShopping',
  description:
    'Use Google Shopping with AI-enhanced planning to curate product recommendations from trusted Indian retailers. Requires confirmed user approval after summarizing needs.',
  parameters: [
    {
      name: 'query',
      description: 'Confirmed search query that includes the product type, relevant specs, and ideally the India context.',
      type: 'string',
      required: true,
    },
    {
      name: 'num',
      description: 'Maximum number of raw results per candidate query (default 30, range 5-50).',
      type: 'number',
      required: false,
    },
    {
      name: 'location',
      description: 'Geo location for the search (defaults to India).',
      type: 'string',
      required: false,
    },
    {
      name: 'minPrice',
      description: 'Minimum price filter in Indian Rupees.',
      type: 'number',
      required: false,
    },
    {
      name: 'maxPrice',
      description: 'Maximum price filter in Indian Rupees.',
      type: 'number',
      required: false,
    },
  ],
};

export const addToWishlistToolDefinition: ToolDefinition = {
  name: 'addToWishlist',
  description: 'Persist a curated product to the wishlist with the user\'s target price for future tracking.',
  parameters: [
    {
      name: 'productName',
      description: 'Exact product name taken from the search results output.',
      type: 'string',
      required: true,
    },
    {
      name: 'productLink',
      description: 'Direct link to the product page from the retailer.',
      type: 'string',
      required: true,
    },
    {
      name: 'currentPrice',
      description: 'Current price string as displayed in the search results (e.g., "₹54,999").',
      type: 'string',
      required: true,
    },
    {
      name: 'desiredPrice',
      description: 'User\'s target price string (e.g., "₹50,000").',
      type: 'string',
      required: true,
    },
    {
      name: 'rating',
      description: 'Optional rating for the product (e.g., "4.5/5").',
      type: 'string',
      required: false,
    },
    {
      name: 'source',
      description: 'Store or platform name, such as "Amazon.in".',
      type: 'string',
      required: true,
    },
  ],
};

export const viewWishlistToolDefinition: ToolDefinition = {
  name: 'viewWishlist',
  description: 'Render the saved wishlist in the console so the user can review tracked products.',
  parameters: [],
};

export const getProductDetailsToolDefinition: ToolDefinition = {
  name: 'getProductDetails',
  description: 'Resolve shorthand references such as "#1" or "cheapest" to the full product data from the most recent search.',
  parameters: [
    {
      name: 'productReference',
      description: 'Identifier or description the user supplied for the product they mean.',
      type: 'string',
      required: true,
    },
  ],
};

export const amazonProductLookupToolDefinition: ToolDefinition = {
  name: 'amazonProductLookup',
  description: 'Parse an Amazon.in product link or ASIN, summarise the listing, and compare prices across other Indian retailers.',
  parameters: [
    {
      name: 'asinOrUrl',
      description: 'Amazon.in product URL or ASIN code to inspect.',
      type: 'string',
      required: true,
    },
  ],
};

const shoppingService = new ShoppingSearchService();

class WishlistPresenter {
  static render(items: WishlistItem[]): string {
    if (!items || items.length === 0) {
      return '\n📭 Your wishlist is empty. Ask me to save a product anytime!\n';
    }

    let output = '\n' + '='.repeat(120) + '\n';
    output += '💝 YOUR WISHLIST\n';
    output += '='.repeat(120) + '\n\n';

    items.forEach((item, index) => {
      const rank = index + 1;
      output += `${rank}. ${item.name}\n`;
      output += `   💵 Current: ${item.currentPrice} | 🎯 Target: ${item.desiredPrice}\n`;
      output += `   🏪 Store: ${item.source}${item.rating ? ` • ⭐ ${item.rating}` : ''}\n`;
      output += `   🔗 Link: ${item.link}\n`;
      if (item.dateAdded) output += `   🗓️ Added: ${item.dateAdded}\n`;
      output += '\n';
    });

    output += '='.repeat(120) + '\n';
    output += 'Tip: say "show wishlist" anytime to revisit these products.\n';
    output += '='.repeat(120) + '\n';

    return output;
  }
}

async function displayWishlist(): Promise<string> {
  const items = await getWishlist();
  return WishlistPresenter.render(items);
}

function logSearchResponse(response: ShoppingSearchResponse): void {
  console.log('\n🤖 AI Search Plan Summary\n');
  console.log(`${response.plannerSummary}\n`);

  const candidateSummaries = SearchResultPresenter.summarizeCandidates(response.candidates);
  if (candidateSummaries.length > 0) {
    console.log('🔎 Strategies considered:');
    candidateSummaries.forEach((line) => console.log(line));
    console.log();
  }

  console.log(SearchResultPresenter.formatResultsTable(response.results));

  if (response.insights.length > 0) {
    console.log('📈 Key insights:');
    response.insights.forEach((line) => console.log(`   ${line}`));
    console.log();
  }

  if (response.suggestions.length > 0) {
    console.log('💡 Suggestions to refine:');
    response.suggestions.forEach((line) => console.log(`   ${line}`));
    console.log();
  }
}

const createTool = tool as unknown as (options: {
  description: string;
  parameters: z.ZodType<any>;
  execute: (params: any) => Promise<any>;
}) => any;

export const searchShoppingTool = createTool({
  description: `🛒 GOOGLE SHOPPING SEARCH — AI-enhanced product discovery.

  Workflow (always follow):
  1. Gather requirements (product, usage, budget, must-have features).
  2. Confirm the summary with the user and ask for explicit go-ahead.
  3. Only then invoke this tool with a proper search query.

  IMPORTANT: The 'query' parameter is REQUIRED and must be a clear search string.
  Example: searchShopping({ query: "realme smartphone under 15000 India" })`,

  parameters: z.object({
    query: z.string().min(1).describe('REQUIRED: Confirmed search query including product, specs, and ideally "India". Example: "laptop under 50000 India"'),
    num: z.number().int().min(5).max(50).optional().describe('Maximum raw results per candidate query (default: 30).'),
    location: z.string().optional().describe('Location context for the search (default: India).'),
    minPrice: z.number().optional().describe('Minimum price filter in INR.'),
    maxPrice: z.number().optional().describe('Maximum price filter in INR.'),
  }),

  execute: async ({ query, num, location, minPrice, maxPrice }) => {
    try {
      // Debug: Log the actual parameters received
      logger.debug('sera-tool', 'searchShoppingTool invoked with params:', {
        query: query ?? 'undefined',
        num: num ?? 'undefined',
        location: location ?? 'undefined',
        minPrice: minPrice ?? 'undefined',
        maxPrice: maxPrice ?? 'undefined',
      });

      if (!query) {
        logger.error('sera-tool', 'Query parameter is missing', new Error('Query parameter undefined'));
        return {
          status: 'error',
          message: 'Query parameter is required but was not provided.',
          resultsCount: 0,
          results: [],
          suggestions: ['Please provide a search query describing what you want to find.'],
          insights: [],
        };
      }

      logger.info('sera', `Running AI shopping search for: ${query}`);

      const response = await shoppingService.search(query, {
        num,
        location,
        minPrice,
        maxPrice,
      });

      logSearchResponse(response);

      return {
        status: response.results.length > 0 ? 'displayed' : 'no_results',
        message:
          response.results.length > 0
            ? `Displayed ${response.results.length} curated products from trusted retailers.`
            : 'No high-quality products matched the filters. Suggestions were provided.',
        resultsCount: response.results.length,
        results: response.results,
        suggestions: response.suggestions,
        insights: response.insights,
        planner: response.planner,
        plannerSummary: response.plannerSummary,
        candidateQueries: response.candidates.map((entry) => ({
          query: entry.query.query,
          weight: entry.query.weight,
          products: entry.products.length,
        })),
        usedFallback: response.usedFallback,
        rawResultCount: response.rawResultCount,
      };
    } catch (error: any) {
      logger.error('sera', 'Shopping search failed', error);
      return {
        status: 'error',
        message: `Shopping search failed: ${error.message}`,
      };
    }
  },
});

function summarizeAmazonResults(results: AmazonSearchResult[]): void {
  if (results.length === 0) {
    console.log('⚠️ Amazon did not return detailed results. Falling back to multi-platform comparison.');
    return;
  }

  console.log('\n🛒 Amazon listing snapshot:');
  results.slice(0, 3).forEach((item, index) => {
    console.log(`${index + 1}. ${item.title}`);
    if (item.price) console.log(`   💵 Price: ${item.price}`);
    if (item.rating) console.log(`   ⭐ Rating: ${item.rating}${item.reviews ? ` (${item.reviews})` : ''}`);
    console.log(`   🔗 Link: ${item.link}`);
  });
}

export const amazonProductLookupTool = createTool({
  description: `🔍 AMAZON PRODUCT LOOKUP — Parse Amazon.in links and compare prices across platforms.`,

  parameters: z.object({
    asinOrUrl: z.string().describe('Amazon.in product URL or ASIN code.'),
  }),

  execute: async ({ asinOrUrl }: { asinOrUrl: string }) => {
    console.log('\n🔍 Inspecting Amazon product link...');

    try {
      const { results: amazonResults, query: derivedQuery } = await searchAmazonProduct(asinOrUrl);
      summarizeAmazonResults(amazonResults);

      const comparisonQuery = SearchResultPresenter.deriveAmazonComparisonQuery(
        derivedQuery || asinOrUrl,
        amazonResults,
      );
      console.log(`\n🔄 Comparing "${comparisonQuery}" across Indian retailers...\n`);

      const comparison = await shoppingService.search(comparisonQuery, {});
      logSearchResponse(comparison);

      return {
        success: true,
        amazonResults,
        comparisonResults: comparison.results,
        suggestions: comparison.suggestions,
        insights: comparison.insights,
        plannerSummary: comparison.plannerSummary,
      };
    } catch (error: any) {
      logger.error('sera', 'Amazon lookup failed', error);
      return {
        success: false,
        message: `Amazon lookup failed: ${error.message}`,
      };
    }
  },
});

export const addToWishlistTool = createTool({
  description: `💝 ADD TO WISHLIST — Save a product along with your target price.`,

  parameters: z.object({
    productName: z.string().describe('Exact product name from the search results.'),
    productLink: z.string().describe('Direct store link from the search results.'),
    currentPrice: z.string().describe('Current price string, e.g., "₹54,999".'),
    desiredPrice: z.string().describe('User target price, e.g., "₹50,000".'),
    rating: z.string().optional().describe('Product rating, e.g., "4.5/5".'),
    source: z.string().describe('Store/platform name, e.g., "Amazon.in".'),
  }),

  execute: async ({ productName, productLink, currentPrice, desiredPrice, rating, source }) => {
    try {
      const item: WishlistItem = {
        name: productName,
        link: productLink,
        currentPrice,
        desiredPrice,
        rating: rating ?? undefined,
        source,
        dateAdded: new Date().toISOString().split('T')[0] ?? undefined,
      };

      const saved = await addToWishlist(item);

      console.log('\n✅ Added to wishlist!');
      console.log(`📦 Product: ${productName}`);
      console.log(`💵 Current: ${currentPrice} | 🎯 Target: ${desiredPrice}`);
      console.log(`🏪 Store: ${source}${rating ? ` • ⭐ ${rating}` : ''}`);
      console.log(`💾 Saved to database with ID: ${saved.id}`);
      console.log('💡 Say "show wishlist" anytime to revisit saved products.\n');

      return {
        success: true,
        message: 'Product saved to wishlist in database.',
        id: saved.id,
      };
    } catch (error: any) {
      logger.error('sera', 'Failed to add to wishlist', error);
      return {
        success: false,
        message: `Failed to add to wishlist: ${error.message}`,
      };
    }
  },
});

export const viewWishlistTool = createTool({
  description: `📋 VIEW WISHLIST — Display all saved products with current versus target prices.`,

  parameters: z.object({}),

  execute: async () => {
    try {
      const output = await displayWishlist();
      console.log(output);
      return {
        success: true,
        message: 'Wishlist displayed in console.',
      };
    } catch (error: any) {
      logger.error('sera', 'Failed to display wishlist', error);
      return {
        success: false,
        message: `Failed to display wishlist: ${error.message}`,
      };
    }
  },
});

export const getProductDetailsTool = createTool({
  description: `🔍 GET PRODUCT DETAILS — Resolve references like "#1" or "cheapest" to exact product data before saving.`,

  parameters: z.object({
    productReference: z.string().describe('Reference used by the user, e.g., "#1", "cheapest", "best rated".'),
  }),

  execute: async ({ productReference }: { productReference: string }) => {
    return {
      success: false,
      message: 'This tool requires conversation context and is implemented inside the Sera agent session.',
      productReference,
    };
  },
});

export type { SearchResult };
