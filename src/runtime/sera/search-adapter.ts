import { getProductDetailsTool, type SearchResult } from '../../tools/sera.js';
import { logger } from '../shared/logger.js';
import { searchAmazonProduct, type AmazonSearchResult } from './sera-search.js';
import { SearchResultPresenter } from './services/search-service.js';
import type { SeraConversation } from './types.js';

export interface AmazonLinkResponse {
  message: string;
  searchResults?: SearchResult[];
}

export class SeraSearchAdapter {
  createContextualProductDetailsTool(session: SeraConversation) {
    return {
      ...getProductDetailsTool,
      execute: async (params: { productReference: string }) => {
        const { productReference } = params;
        const results = session.lastSearchResults;

        if (!results || results.length === 0) {
          return {
            success: false,
            message: 'No recent search results available. Please search for products first.',
          };
        }

        const product = this.findProductByReference(productReference, results);
        if (!product) {
          return {
            success: false,
            message: `Could not find product matching "${productReference}". Try using a number like "#1", "#2", etc.`,
          };
        }

        return {
          success: true,
          product: {
            number: results.indexOf(product) + 1,
            title: product.title,
            link: product.link,
            price: product.price || 'N/A',
            priceNumeric: product.price ? parseFloat(product.price.replace(/[^\d.]/g, '')) : 0,
            rating: product.rating || 'N/A',
            source: product.source,
          },
        };
      },
    };
  }

  findProductByReference(reference: string, results: SearchResult[]): SearchResult | null {
    const ref = reference.toLowerCase().trim();

    const numberMatch = ref.match(/#?(\d+)/);
    if (numberMatch) {
      const indexToken = numberMatch[1];
      if (indexToken) {
        const index = Number.parseInt(indexToken, 10) - 1;
        return results[index] ?? null;
      }
    }

    const wordNumbers: Record<string, number> = {
      first: 0,
      second: 1,
      third: 2,
      fourth: 3,
      fifth: 4,
      last: results.length - 1,
    };
    if (wordNumbers[ref] !== undefined) {
      return results[wordNumbers[ref]] || null;
    }

    if (ref.includes('cheap') || ref.includes('lowest price')) {
      return results.reduce((min, curr) => {
        const minPrice = min.price ? parseFloat(min.price.replace(/[^\d.]/g, '')) : Infinity;
        const currPrice = curr.price ? parseFloat(curr.price.replace(/[^\d.]/g, '')) : Infinity;
        return currPrice < minPrice ? curr : min;
      });
    }

    if (ref.includes('expensive') || ref.includes('priciest')) {
      return results.reduce((max, curr) => {
        const maxPrice = max.price ? parseFloat(max.price.replace(/[^\d.]/g, '')) : 0;
        const currPrice = curr.price ? parseFloat(curr.price.replace(/[^\d.]/g, '')) : 0;
        return currPrice > maxPrice ? curr : max;
      });
    }

    if (ref.includes('best rated') || ref.includes('highest rated') || ref.includes('top rated')) {
      return results.reduce((max, curr) => {
        const maxRating = max.rating ? parseFloat(max.rating) : 0;
        const currRating = curr.rating ? parseFloat(curr.rating) : 0;
        return currRating > maxRating ? curr : max;
      });
    }

    const storeMatch = ref.match(/(amazon|flipkart|croma|myntra|ajio)/i);
    if (storeMatch) {
      const store = storeMatch[1];
      if (store) {
        return results.find((r) => r.source.toLowerCase().includes(store.toLowerCase())) ?? null;
      }
    }

    return null;
  }

  extractAmazonUrl(message: string): string | undefined {
    const urlMatch = message.match(/https?:\/\/[^\s]*amazon\.[^\s]+/i);
    if (!urlMatch?.[0]) {
      return undefined;
    }

    return urlMatch[0].replace(/[),.;!?]+$/, '');
  }

  async handleAmazonLinkRequest(
    session: SeraConversation,
    amazonUrl: string
  ): Promise<AmazonLinkResponse> {
    let amazonResults: AmazonSearchResult[] = [];
    let derivedSource: string | undefined = amazonUrl;

    try {
      const lookup = await searchAmazonProduct(amazonUrl);
      amazonResults = lookup.results;
      if (lookup.query) {
        derivedSource = lookup.query;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('sera', `Amazon lookup failed; falling back to URL parsing: ${message}`);
    }

    if (amazonResults.length === 0) {
      try {
        const fallbackResult = await this.createSearchResultFromUrl(amazonUrl);
        if (!fallbackResult) {
          return {
            message:
              "I tried to parse that Amazon link but couldn't extract the product details yet. Could you describe the item so I can search manually?",
          };
        }

        session.lastSearchResults = [fallbackResult];
        const formatted = SearchResultPresenter.formatResultsTable([fallbackResult]);
        return {
          message: [
            "Here's the listing I could pull directly from Amazon:",
            formatted,
            'Let me know if you want me to compare it with other stores afterward.',
          ].join('\n\n'),
          searchResults: session.lastSearchResults,
        };
      } catch (fallbackError) {
        const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        logger.error('sera', 'Amazon parsing failed', fallbackError);
        return {
          message: `I tried to inspect that Amazon link but hit an error: ${message}. Want to describe the product instead?`,
        };
      }
    }

    const normalizedResults = SearchResultPresenter.mapAmazonResults(amazonResults.slice(0, 5));
    session.lastSearchResults = normalizedResults;

    const formatted = SearchResultPresenter.formatResultsTable(normalizedResults);
    const headline = amazonResults[0]?.title ?? derivedSource ?? 'this Amazon product';

    return {
      message: [
        `Here are the closest matches I pulled straight from Amazon for "${headline}":`,
        formatted,
        'Pick a number to save it, or say "compare" if you want me to check other retailers after this.',
      ].join('\n\n'),
      searchResults: normalizedResults,
    };
  }

  async createSearchResultFromUrl(productUrl: string): Promise<SearchResult | null> {
    if (!productUrl) {
      return null;
    }

    try {
      if (/amazon\./i.test(productUrl)) {
        const { results } = await searchAmazonProduct(productUrl);
        const product = results[0];
        if (!product) {
          return null;
        }

        const mapped: SearchResult = {
          title: product.title,
          source: 'Amazon.in',
          link: product.link || productUrl,
        };

        if (product.price) mapped.price = product.price;
        if (product.priceNumeric !== undefined) mapped.priceNumeric = product.priceNumeric;
        if (product.rating) mapped.rating = product.rating;
        if (product.ratingNumeric !== undefined) mapped.ratingNumeric = product.ratingNumeric;
        if (product.reviews) mapped.reviews = product.reviews;
        if (product.reviewCount !== undefined) mapped.reviewCount = product.reviewCount;
        if (product.delivery) mapped.delivery = product.delivery;
        if (product.thumbnail) mapped.thumbnail = product.thumbnail;

        return mapped;
      }
    } catch (error) {
      logger.error('sera', 'Direct product fetch failed', error);
    }

    return null;
  }
}
