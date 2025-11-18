/**
 * Shopping search orchestration utilities for the Sera agent.
 * Encapsulates planning, execution, aggregation, and presentation concerns.
 */

import {
  planSearch,
  formatPlannerExplanation,
  extractSearchParams,
  type CandidateQuery,
  type PlannerOutput,
} from '../agent/search-planner';
import { logger } from '../../shared/logger';

type LoggerLike = Pick<typeof logger, 'info' | 'warn'>;

export interface AmazonSearchResult {
  title: string;
  price?: string;
  priceNumeric?: number;
  rating?: string;
  ratingNumeric?: number;
  reviews?: string;
  reviewCount?: number;
  link: string;
  delivery?: string;
  thumbnail?: string;
}

interface GoogleShoppingParams {
  num?: number;
  location?: string;
  googleDomain?: string;
  hl?: string;
  gl?: string;
  currency?: string;
  minPrice?: number;
  maxPrice?: number;
  offersOnly?: boolean;
  store?: string;
}

interface GoogleShoppingResponse {
  shopping_results?: any[];
  organic_results?: any[];
  error?: string;
  [key: string]: unknown;
}

interface AmazonLookupResponse {
  raw: unknown;
  results: AmazonSearchResult[];
  query: string;
}

function getSerpApiKey(): string {
  const key = process.env.SERPAPI_KEY;
  if (!key) {
    throw new Error('SERPAPI_KEY is required');
  }
  return key;
}

async function fetchFromSerpApi(url: URL): Promise<any> {
  const res = await fetch(url.toString());
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`SerpApi request failed: ${res.status} ${res.statusText} -> ${errorText}`);
  }
  const data: any = await res.json();
  if (data?.error) {
    throw new Error(`SerpApi error: ${data.error}`);
  }
  return data;
}

export async function searchGoogleShopping(
  query: string,
  params: GoogleShoppingParams = {}
): Promise<GoogleShoppingResponse> {
  const key = getSerpApiKey();
  const {
    num = 25,
    location = 'India',
    googleDomain = 'google.co.in',
    hl = 'en',
    gl = 'in',
    currency = 'INR',
    minPrice,
    maxPrice,
    offersOnly,
    store,
  } = params;

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_shopping');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(num));
  url.searchParams.set('location', location);
  url.searchParams.set('google_domain', googleDomain);
  url.searchParams.set('hl', hl);
  url.searchParams.set('gl', gl);
  url.searchParams.set('currency', currency);

  if (typeof minPrice === 'number') {
    url.searchParams.set('min_price', String(Math.round(minPrice)));
  }
  if (typeof maxPrice === 'number') {
    url.searchParams.set('max_price', String(Math.round(maxPrice)));
  }
  if (typeof offersOnly === 'boolean') {
    url.searchParams.set('offers_only', offersOnly ? 'true' : 'false');
  }
  if (store) {
    url.searchParams.set('store', store);
  }

  url.searchParams.set('api_key', key);
  return fetchFromSerpApi(url);
}

export async function searchAmazonProduct(rawInput: string): Promise<AmazonLookupResponse> {
  const key = getSerpApiKey();
  const asinOrUrl = rawInput?.trim();
  if (!asinOrUrl) {
    throw new Error('Amazon lookup requires a valid ASIN or product URL.');
  }

  let searchQuery = asinOrUrl;
  if (asinOrUrl.includes('amazon.in') || asinOrUrl.includes('amazon.com')) {
    const urlMatch = asinOrUrl.match(/amazon\.[a-z.]+\/([^/]+)\/(?:dp|gp)\//i);
    if (urlMatch?.[1]) {
      const decoded = decodeURIComponent(urlMatch[1]);
      searchQuery = decoded.replace(/[-+]/g, ' ').replace(/%20/g, ' ').trim();
    }
  }

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'amazon');
  url.searchParams.set('k', searchQuery);
  url.searchParams.set('amazon_domain', 'amazon.in');
  url.searchParams.set('language', 'en_IN');
  url.searchParams.set('api_key', key);

  const data = await fetchFromSerpApi(url);
  const organic = Array.isArray(data?.organic_results) ? data.organic_results : [];

  const results: AmazonSearchResult[] = organic.map((item: any) => ({
    title: item.title || '',
    price: item.price || undefined,
    priceNumeric: typeof item.extracted_price === 'number' ? item.extracted_price : undefined,
    rating: item.rating ? `${item.rating}/5` : undefined,
    ratingNumeric: typeof item.rating === 'number' ? item.rating : undefined,
    reviews: item.reviews ? `${item.reviews}` : undefined,
    reviewCount: typeof item.reviews === 'number' ? item.reviews : undefined,
    link: item.link || '',
    delivery: item.delivery || undefined,
    thumbnail: item.thumbnail || undefined,
  }));

  return {
    raw: data,
    results,
    query: searchQuery,
  };
}

export interface ShoppingSearchOptions {
  num?: number;
  location?: string;
  minPrice?: number;
  maxPrice?: number;
  skipPlanner?: boolean;
}

export interface SearchResult {
  title: string;
  price?: string;
  priceNumeric?: number;
  source: string;
  rating?: string;
  ratingNumeric?: number;
  reviews?: string;
  reviewCount?: number;
  link: string;
  delivery?: string;
  thumbnail?: string;
  snippet?: string;
  isDeal?: boolean;
  dealInfo?: string;
  oldPrice?: string;
  savings?: string;
  merchantTier?: 'official' | 'major' | 'verified' | 'third-party' | 'unknown';
  merchantTrustScore?: number;
  merchantBadge?: string;
  isSecondHand?: boolean;
  secondHandCondition?: string;
  badge?: string;
  valueScore?: number;
  candidateQuery?: string;
  candidateWeight?: number;
  aggregationScore?: number;
}

export interface CandidateSearchResult {
  query: CandidateQuery;
  products: SearchResult[];
}

export interface ShoppingSearchResponse {
  results: SearchResult[];
  planner: PlannerOutput;
  plannerSummary: string;
  suggestions: string[];
  insights: string[];
  candidates: CandidateSearchResult[];
  usedFallback: boolean;
  rawResultCount: number;
}

interface SearchParams {
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  location: string;
}

class SearchResultUtils {
  private static categorizeMerchant(merchantName: string): {
    tier: 'official' | 'major' | 'verified' | 'third-party' | 'unknown';
    trustScore: number;
    badge: string;
  } {
    const merchant = merchantName.toLowerCase();

    const officialStores = [
      'apple',
      'samsung',
      'oneplus',
      'realme',
      'xiaomi',
      'mi',
      'oppo',
      'vivo',
      'sony',
      'lg',
      'dell',
      'hp',
      'lenovo',
      'asus',
      'acer',
      'boat',
      'noise',
    ];

    const majorRetailers = [
      'amazon',
      'flipkart',
      'croma',
      'reliance digital',
      'reliance',
      'tatacliq',
      'tata cliq',
      'myntra',
      'ajio',
      'vijay sales',
      'jiomart',
      'snapdeal',
    ];

    const verifiedSellers = [
      'paytm',
      'shopclues',
      'pepperfry',
      'urban ladder',
      'nykaa',
      'firstcry',
      'bigbasket',
    ];

    if (officialStores.some((store) => merchant.includes(store))) {
      return { tier: 'official', trustScore: 95, badge: '✅ Official Store' };
    }

    if (majorRetailers.some((retailer) => merchant.includes(retailer))) {
      return { tier: 'major', trustScore: 90, badge: '🏪 Trusted Retailer' };
    }

    if (verifiedSellers.some((seller) => merchant.includes(seller))) {
      return { tier: 'verified', trustScore: 75, badge: '✓ Verified Seller' };
    }

    if (merchant.includes('store') || merchant.includes('shop')) {
      return { tier: 'third-party', trustScore: 60, badge: '⚠️ Third-party Seller' };
    }

    return { tier: 'unknown', trustScore: 50, badge: '❓ Unknown Seller' };
  }

  private static calculateValueScore(rating: number, price: number, maxPrice: number): number {
    const ratingScore = rating / 5;
    const priceScore = maxPrice > 0 ? 1 - Math.min(price / maxPrice, 1) : 0;
    return ratingScore * 0.6 + priceScore * 0.4;
  }

  static addBadges(results: SearchResult[]): void {
    if (results.length === 0) return;

    const prices = results
      .map((item) => item.priceNumeric)
      .filter((value): value is number => typeof value === 'number');
    const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

    results.forEach((item) => {
      const rating = item.ratingNumeric ?? 0;
      const price = item.priceNumeric ?? maxPrice ?? 0;
      item.valueScore = this.calculateValueScore(rating, price, maxPrice || price || 1);
    });

    const byRating = [...results].sort((a, b) => (b.ratingNumeric ?? 0) - (a.ratingNumeric ?? 0));
    const byPrice = [...results].sort((a, b) => (a.priceNumeric ?? Infinity) - (b.priceNumeric ?? Infinity));
    const byValue = [...results].sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0));
    const byReviews = [...results].sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0));

    if (byRating[0]) byRating[0].badge = '🌟 Highest Rated';
    if (byPrice[0]) byPrice[0].badge = '⚡ Cheapest';
    if (byValue[0]) byValue[0].badge = '🥇 Best Value';
    if (byReviews[0] && (byReviews[0].reviewCount ?? 0) > 10000) {
      byReviews[0].badge = byReviews[0].badge ? `${byReviews[0].badge} • 🔥 Most Popular` : '🔥 Most Popular';
    }
  }

  static generateRefinementSuggestions(
    query: string,
    resultsCount: number,
    minPrice?: number,
    maxPrice?: number,
  ): string[] {
    const suggestions: string[] = [];
    
    // Guard against undefined query
    if (!query) {
      suggestions.push('⚠️ Please provide a search query to find products.');
      return suggestions;
    }
    
    const queryLower = query.toLowerCase();
    const words = queryLower.split(/\s+/);

    const hasMultipleSpecs =
      words.filter((w) =>
        /^(?:\d+gb|\d+tb|\d+inch|\d+")|\d+mp|\d+hz|gen\d+|i\d+|ryzen\d+/i.test(w),
      ).length >= 3;

    const brands = ['apple', 'samsung', 'oneplus', 'xiaomi', 'realme', 'oppo', 'vivo', 'dell', 'hp', 'lenovo', 'asus'];
    const hasBrand = brands.some((brand) => queryLower.includes(brand));
    const hasModelNumber = /[a-z]\d{2,}|[A-Z]{2,}\d{2,}/.test(query);

    if (resultsCount === 0) {
      if (hasMultipleSpecs || (hasBrand && hasModelNumber)) {
        suggestions.push('🎯 Your search is very specific. Try removing model numbers or extra specifications.');
        suggestions.push(`💡 Example: "${query.split(' ').slice(0, 2).join(' ')}" instead of "${query}"`);
      }

      if (words.some((w) => w.length > 8 && !/[aeiou]/i.test(w))) {
        suggestions.push('✏️ Double-check spelling. Some words may contain typos.');
      }

      if (typeof maxPrice === 'number' && maxPrice < 10000) {
        suggestions.push(`💰 Budget of ₹${maxPrice.toLocaleString('en-IN')} might be too low. Try increasing it.`);
      }
      if (typeof minPrice === 'number' && minPrice > 100000) {
        suggestions.push(`💎 Minimum price ₹${minPrice.toLocaleString('en-IN')} is quite high. Try lowering it.`);
      }

      suggestions.push('🔍 Use broader terms (e.g., "laptop" instead of "gaming laptop 16GB RTX3060").');
      suggestions.push('🏷️ Remove brand filters or try popular alternatives.');
      return suggestions;
    }

    if (resultsCount <= 2) {
      if (hasMultipleSpecs) {
        suggestions.push('📊 Limited matches. Relax some specifications for more choices.');
      }

      if (typeof minPrice === 'number' && typeof maxPrice === 'number' && maxPrice - minPrice < 5000) {
        suggestions.push(
          `💵 Price range ₹${minPrice.toLocaleString('en-IN')} - ₹${maxPrice.toLocaleString('en-IN')} is narrow. Expand it for better coverage.`,
        );
      }

      suggestions.push('🔄 Consider similar products or alternative brands for variety.');
      return suggestions;
    }

    if (resultsCount < 10 && hasMultipleSpecs) {
      suggestions.push('💡 Good matches found. Removing a few specs could surface more options.');
    }

    return suggestions;
  }

  private static normalizeTitle(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  private static calculateTitleSimilarity(title1: string, title2: string): number {
    const normalized1 = this.normalizeTitle(title1);
    const normalized2 = this.normalizeTitle(title2);

    if (!normalized1 || !normalized2) return 0;

    const words1 = new Set(normalized1.split(' '));
    const words2 = new Set(normalized2.split(' '));

    const intersection = [...words1].filter((word) => words2.has(word));
    const union = new Set([...words1, ...words2]);

    return union.size === 0 ? 0 : intersection.length / union.size;
  }

  private static deduplicateProducts(products: SearchResult[], similarityThreshold: number = 0.7): SearchResult[] {
    const unique: SearchResult[] = [];
    const seen = new Set<number>();

    for (let i = 0; i < products.length; i++) {
      if (seen.has(i)) continue;

      const base = products[i];
      if (!base) continue;

      let bestMatch: SearchResult = base;
      let bestScore = base.aggregationScore ?? 0;

      for (let j = i + 1; j < products.length; j++) {
        if (seen.has(j)) continue;

        const other = products[j];
        if (!other) continue;

        const similarity = this.calculateTitleSimilarity(base.title, other.title);

        if (similarity >= similarityThreshold) {
          seen.add(j);
          const otherScore = other.aggregationScore ?? 0;
          if (otherScore > bestScore) {
            bestMatch = other;
            bestScore = otherScore;
          }
        }
      }

      unique.push(bestMatch);
    }

    return unique;
  }

  static formatEnhancedResults(shoppingResults: any[]): SearchResult[] {
    const formatted = shoppingResults
      .map((item: any) => {
        const result: SearchResult = {
          title: item.title || item.product_title || 'Unknown Product',
          source: item.source || item.merchant || 'Unknown',
          link: item.product_link || item.link || item.serpapi_product_api || '#',
          delivery: item.delivery || undefined,
          thumbnail: item.thumbnail || undefined,
          snippet: item.snippet || undefined,
        };

        if (typeof item.extracted_price === 'number') {
          result.priceNumeric = item.extracted_price;
          result.price = `₹${item.extracted_price.toLocaleString('en-IN')}`;
        } else if (item.price) {
          const numeric = Number.parseFloat(String(item.price).replace(/[^0-9.]/g, ''));
          if (!Number.isNaN(numeric)) {
            result.priceNumeric = numeric;
            result.price = `₹${numeric.toLocaleString('en-IN')}`;
          }
        }

        if (typeof item.rating === 'number') {
          result.ratingNumeric = item.rating;
          result.rating = `${item.rating.toFixed(1)}/5`;
        } else if (item.rating) {
          const numeric = Number.parseFloat(item.rating);
          if (!Number.isNaN(numeric)) {
            result.ratingNumeric = numeric;
            result.rating = `${numeric.toFixed(1)}/5`;
          }
        }

        if (typeof item.reviews === 'number') {
          result.reviewCount = item.reviews;
          result.reviews = `${item.reviews.toLocaleString('en-IN')} reviews`;
        } else if (typeof item.reviews === 'string') {
          const numeric = Number.parseInt(item.reviews.replace(/[^0-9]/g, ''), 10);
          if (!Number.isNaN(numeric)) {
            result.reviewCount = numeric;
            result.reviews = `${numeric.toLocaleString('en-IN')} reviews`;
          }
        }

        if (item.second_hand_condition) {
          result.isSecondHand = true;
          result.secondHandCondition = item.second_hand_condition;
        }

        if (item.tag || (Array.isArray(item.extensions) && item.extensions.length > 0)) {
          result.isDeal = true;
          result.dealInfo = item.tag || item.extensions[0];
        }

        const merchantInfo = this.categorizeMerchant(result.source);
        result.merchantTier = merchantInfo.tier;
        result.merchantTrustScore = merchantInfo.trustScore;
        result.merchantBadge = merchantInfo.badge;

        if ((item.old_price && result.priceNumeric) || item.extracted_old_price) {
          const oldPriceNumeric =
            typeof item.extracted_old_price === 'number'
              ? item.extracted_old_price
              : Number.parseFloat(String(item.old_price).replace(/[^0-9.]/g, ''));
          if (oldPriceNumeric && result.priceNumeric && oldPriceNumeric > result.priceNumeric) {
            const savings = oldPriceNumeric - result.priceNumeric;
            const savingsPercent = Math.round((savings / oldPriceNumeric) * 100);
            result.oldPrice = `₹${oldPriceNumeric.toLocaleString('en-IN')}`;
            result.savings = `Save ₹${savings.toLocaleString('en-IN')} (${savingsPercent}%)`;
          }
        }

        return result;
      })
      .filter((result) => {
        const rating = result.ratingNumeric ?? 0;
        const reviews = result.reviewCount ?? 0;
        const trustScore = result.merchantTrustScore ?? 0;

        if (typeof result.priceNumeric !== 'number') return false;
        if (result.isSecondHand) return false;
        if (rating < 3.8) return false;
        if (reviews < 50) return false;
        if (trustScore < 75) return false;
        return true;
      });

    formatted.sort((a, b) => {
      const ratingDiff = (b.ratingNumeric ?? 0) - (a.ratingNumeric ?? 0);
      if (ratingDiff !== 0) return ratingDiff;
      return (a.priceNumeric ?? Infinity) - (b.priceNumeric ?? Infinity);
    });

    return formatted.slice(0, 10);
  }

  static aggregateCandidateResults(candidateResults: CandidateSearchResult[]): SearchResult[] {
    const all: SearchResult[] = [];

    for (const entry of candidateResults) {
      const weight = entry.query.weight ?? 0;
      entry.products.forEach((product) => {
        const ratingScore = (product.ratingNumeric ?? 0) / 5;
        const priceScore = product.priceNumeric ? 1 / (1 + product.priceNumeric / 15000) : 0;
        const reviewScore = Math.min((product.reviewCount ?? 0) / 10000, 1);
        const trustScore = (product.merchantTrustScore ?? 50) / 100;

        product.aggregationScore =
          ratingScore * 0.35 +
          weight * 0.25 +
          priceScore * 0.2 +
          reviewScore * 0.1 +
          trustScore * 0.1;

        product.candidateQuery = entry.query.query;
        product.candidateWeight = weight;
        all.push(product);
      });
    }

    const unique = this.deduplicateProducts(all);
    unique.sort((a, b) => (b.aggregationScore ?? 0) - (a.aggregationScore ?? 0));
    return unique;
  }

  static generateComparisonInsights(results: SearchResult[]): string[] {
    if (results.length < 2) return [];

    const insights: string[] = [];
    const highestRated = [...results].sort((a, b) => (b.ratingNumeric ?? 0) - (a.ratingNumeric ?? 0))[0];
    const cheapest = [...results].sort((a, b) => (a.priceNumeric ?? Infinity) - (b.priceNumeric ?? Infinity))[0];
    const bestValue = [...results].sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0))[0];

    if (highestRated) {
      insights.push(`🌟 ${highestRated.title} has the strongest rating at ${highestRated.rating ?? 'N/A'}.`);
    }
    if (cheapest && cheapest !== highestRated) {
      insights.push(`⚡ ${cheapest.title} is the most affordable at ${cheapest.price ?? 'N/A'} while meeting quality filters.`);
    }
    if (bestValue && bestValue !== cheapest && bestValue !== highestRated) {
      insights.push(`🥇 ${bestValue.title} balances rating and price best (value score ${(bestValue.valueScore ?? 0).toFixed(2)}).`);
    }

    return insights;
  }

  static formatResultsTable(results: SearchResult[]): string {
    if (results.length === 0) {
      return '\n❌ No products matched the quality filters (trusted stores, rating, reviews).\n';
    }

    let output = '\n' + '='.repeat(120) + '\n';
    output += `🛍️ TOP ${results.length} PRODUCTS (Quality filtered)\n`;
    output += '='.repeat(120) + '\n\n';

    results.forEach((item, index) => {
      const rank = index + 1;
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
      const badge = item.badge ? ` ${item.badge}` : '';
      const strategy = item.candidateQuery
        ? `   🎯 Strategy: "${item.candidateQuery}" (${Math.round((item.candidateWeight ?? 0) * 100)}% relevance)\n`
        : '';

      output += `${medal} ${item.title}${badge}\n`;
      output += `   💵 Price: ${item.price ?? 'N/A'}${item.savings ? ` • ${item.savings}` : ''}\n`;

      if (item.rating) {
        output += `   ⭐ Rating: ${item.rating}`;
        if (item.reviews) output += ` (${item.reviews})`;
        output += '\n';
      }

      output += `   🏪 Store: ${item.merchantBadge ?? ''} ${item.source}`;
      if (item.merchantTier === 'third-party' || item.merchantTier === 'unknown') {
        output += ` (Trust: ${item.merchantTrustScore ?? 0}/100)`;
      }
      output += '\n';

      if (item.delivery) output += `   🚚 Delivery: ${item.delivery}\n`;
      if (item.isDeal && item.dealInfo) output += `   🔥 Deal: ${item.dealInfo}\n`;

      output += `   🔗 Link: ${item.link}\n`;
      if (strategy) output += strategy;
      output += '\n';
    });

    output += '='.repeat(120) + '\n';
    return output;
  }
}

export class ShoppingSearchService {
  constructor(private readonly log: LoggerLike = logger) {}

  async search(query: string, options: ShoppingSearchOptions = {}): Promise<ShoppingSearchResponse> {
    // Guard against undefined/empty query
    if (!query || query.trim().length === 0) {
      this.log.warn('sera', 'Empty query provided to search service');
      return {
        results: [],
        planner: {
          queryIntent: 'No query provided',
          priorities: [],
          candidateQueries: [],
        },
        plannerSummary: 'No search query was provided.',
        suggestions: ['Please provide a search query describing what product you want to find.'],
        insights: [],
        candidates: [],
        usedFallback: true,
        rawResultCount: 0,
      };
    }

    const usePlanner = this.shouldUsePlanner(query, options);
    const { planner, usedFallback } = usePlanner
      ? await this.createPlanner(query)
      : this.createDirectPlanner(query);

    if (!planner.candidateQueries || planner.candidateQueries.length === 0) {
      planner.candidateQueries = [
        {
          query,
          weight: 1,
          rationale: 'Direct user query fallback',
        },
      ];
    }

    const plannerSummary = formatPlannerExplanation(planner);
    const searchParams = this.buildSearchParams(planner, options);
    const candidateResults = await this.executeCandidateQueries(
      planner.candidateQueries.slice(0, 5),
      searchParams,
      options.num,
    );

    const aggregated = SearchResultUtils.aggregateCandidateResults(candidateResults);
    SearchResultUtils.addBadges(aggregated);

    const results = aggregated.slice(0, 5);
    const suggestions = SearchResultUtils.generateRefinementSuggestions(
      query,
      aggregated.length,
      searchParams.minPrice,
      searchParams.maxPrice,
    );
    const insights = SearchResultUtils.generateComparisonInsights(results);

    return {
      results,
      planner,
      plannerSummary,
      suggestions,
      insights,
      candidates: candidateResults,
      usedFallback,
      rawResultCount: aggregated.length,
    };
  }

  private async createPlanner(query: string): Promise<{ planner: PlannerOutput; usedFallback: boolean }> {
    try {
      const planner = await planSearch({
        userMessage: query,
        maxCandidates: 5,
        temperature: 0.1,
      });

      return { planner, usedFallback: false };
    } catch (error: any) {
      this.log.warn('sera', `Planner fallback for query "${query}": ${error.message}`);
      const planner: PlannerOutput = {
        queryIntent: `Search for ${query}`,
        priorities: [],
        candidateQueries: [
          {
            query,
            weight: 1,
            rationale: 'Direct user query fallback',
          },
        ],
      };

      return { planner, usedFallback: true };
    }
  }

  private createDirectPlanner(query: string): { planner: PlannerOutput; usedFallback: boolean } {
    const planner: PlannerOutput = {
      queryIntent: `Direct search for ${query}`,
      priorities: [],
      candidateQueries: [
        {
          query,
          weight: 1,
          rationale: 'Planner disabled – using direct query',
        },
      ],
    };

    return { planner, usedFallback: true };
  }

  private shouldUsePlanner(query: string, options: ShoppingSearchOptions): boolean {
    if (options.skipPlanner === true) {
      return false;
    }

    if (options.skipPlanner === false) {
      return true;
    }

    if (!query) {
      return false;
    }

    const plannerKeywordPattern = /\bplan(?:ner|ning)?\b/i;
    return plannerKeywordPattern.test(query);
  }

  private buildSearchParams(planner: PlannerOutput, options: ShoppingSearchOptions): SearchParams {
    const params = extractSearchParams(planner);

    if (options.location) {
      params.location = options.location;
    }

    if (options.minPrice !== undefined) {
      params.minPrice = options.minPrice;
    }

    if (options.maxPrice !== undefined) {
      params.maxPrice = options.maxPrice;
    }

    if (options.minPrice !== undefined || options.maxPrice !== undefined) {
      planner.budget = {
        min: options.minPrice,
        max: options.maxPrice,
        approximate: options.maxPrice ?? options.minPrice,
      };
    }

    return params;
  }

  private async executeCandidateQueries(
    candidates: CandidateQuery[],
    searchParams: SearchParams,
    num?: number,
  ): Promise<CandidateSearchResult[]> {
    this.log.info('sera', `Executing ${candidates.length} shopping strategies`);

    const results = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const baseParams = {
            num: num ?? 30,
            location: searchParams.location,
            googleDomain: 'google.co.in',
            hl: 'en',
            gl: 'in',
            currency: 'INR',
          };

          const rangeParams = {
            ...(typeof searchParams.minPrice === 'number' ? { minPrice: searchParams.minPrice } : {}),
            ...(typeof searchParams.maxPrice === 'number' ? { maxPrice: searchParams.maxPrice } : {}),
          };

          const response = await searchGoogleShopping(candidate.query, {
            ...baseParams,
            ...rangeParams,
          });

          const shoppingResults = Array.isArray(response.shopping_results) ? response.shopping_results : [];
          const formatted = SearchResultUtils.formatEnhancedResults(shoppingResults);

          return { query: candidate, products: formatted };
        } catch (error: any) {
          this.log.warn('sera', `Candidate query failed: "${candidate.query}" -> ${error.message}`);
          return { query: candidate, products: [] };
        }
      }),
    );

    return results;
  }
}

export class SearchResultPresenter {
  static mapAmazonResults(amazonResults: AmazonSearchResult[]): SearchResult[] {
    if (!Array.isArray(amazonResults) || amazonResults.length === 0) {
      return [];
    }

    return amazonResults.map((result, index) => {
      const normalized: SearchResult = {
        title: result.title || `Amazon listing #${index + 1}`,
        source: 'Amazon.in',
        link: result.link || '',
        merchantTier: 'major',
        merchantBadge: '🏪 Amazon.in',
        candidateQuery: 'Amazon direct listing',
        candidateWeight: Math.max(0.1, 1 - index * 0.15),
      };

      if (result.price) {
        normalized.price = result.price;
      }
      if (typeof result.priceNumeric === 'number') {
        normalized.priceNumeric = result.priceNumeric;
      }
      if (result.rating) {
        normalized.rating = result.rating;
      }
      if (typeof result.ratingNumeric === 'number') {
        normalized.ratingNumeric = result.ratingNumeric;
      }
      if (result.reviews) {
        normalized.reviews = result.reviews;
      }
      if (typeof result.reviewCount === 'number') {
        normalized.reviewCount = result.reviewCount;
      }
      if (result.delivery) {
        normalized.delivery = result.delivery;
      }
      if (result.thumbnail) {
        normalized.thumbnail = result.thumbnail;
      }

      if (index === 0) {
        normalized.badge = '🏆 Amazon pick';
      }

      return normalized;
    });
  }

  static formatResultsTable(results: SearchResult[]): string {
    return SearchResultUtils.formatResultsTable(results);
  }

  static summarizeCandidates(candidates: CandidateSearchResult[]): string[] {
    return candidates.map((entry, index) => {
      const pct = Math.round((entry.query.weight ?? 0) * 100);
      return `   ${index + 1}. "${entry.query.query}" (${pct}% relevance) → ${entry.products.length} matches`;
    });
  }

}
