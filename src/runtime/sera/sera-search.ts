/**
 * Sera Search Module - SerpApi integrations for product search
 * Copied and adapted from dist-export/src/bot.ts
 */

export interface GoogleShoppingParams {
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

export interface GoogleShoppingResponse {
  shopping_results?: any[];
  search_metadata?: Record<string, any>;
  [key: string]: any;
}

// Google Shopping search using SerpApi - India-specific
export async function searchGoogleShopping(
  query: string,
  params: GoogleShoppingParams = {}
): Promise<GoogleShoppingResponse> {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error('SERPAPI_KEY is required');

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

  const res = await fetch(url.toString());
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`SerpApi request failed: ${res.status} ${res.statusText} -> ${errorText}`);
  }

  const data = (await res.json()) as GoogleShoppingResponse;

  if ((data as any).error) {
    throw new Error(`SerpApi error: ${(data as any).error}`);
  }

  return data;
}

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

// Amazon Product Search
export async function searchAmazonProduct(asinOrUrl: string): Promise<{
  raw: any;
  results: AmazonSearchResult[];
  query: string;
}> {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error('SERPAPI_KEY is required');

  let searchQuery = asinOrUrl;

  // Extract product name from Amazon URL
  if (asinOrUrl.includes('amazon.in') || asinOrUrl.includes('amazon.com')) {
    const urlMatch = asinOrUrl.match(/amazon\.[a-z.]+\/([^/]+)\/(?:dp|gp)\//i);
    if (urlMatch && urlMatch[1]) {
      searchQuery = urlMatch[1]
        .replace(/-/g, ' ')
        .replace(/%20/g, ' ')
        .replace(/\+/g, ' ')
        .trim();
    }
  }

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'amazon');
  url.searchParams.set('k', searchQuery);
  url.searchParams.set('amazon_domain', 'amazon.in');
  url.searchParams.set('language', 'en_IN');
  url.searchParams.set('api_key', key);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Amazon search failed: ${res.status} ${res.statusText} -> ${errorText}`);
  }

  const data = (await res.json()) as any;
  if (data.error) throw new Error(`SerpApi error: ${data.error}`);

  const organic = Array.isArray(data.organic_results) ? data.organic_results : [];

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

  return { raw: data, results, query: searchQuery };
}
