/**
 * Wishlist API Client
 * HTTP client for interacting with wishlist API endpoints
 * Alternative to direct database access via Prisma
 */

export interface WishlistItem {
  id?: string | undefined;
  name: string;
  link: string;
  currentPrice: string;
  desiredPrice: string;
  rating?: string | undefined;
  source: string;
  dateAdded?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface WishlistApiConfig {
  baseUrl: string;
  apiKey?: string | undefined;
  userId?: number | undefined;
}

export class WishlistApiClient {
  private baseUrl: string;
  private apiKey: string | undefined;
  private userId: number | undefined;

  constructor(config: WishlistApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = config.apiKey;
    this.userId = config.userId;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get all wishlist items
   */
  async getWishlist(options?: {
    limit?: number;
    sortBy?: 'date_added' | 'current_price' | 'name';
    order?: 'asc' | 'desc';
  }): Promise<{ items: WishlistItem[]; count: number; owner: number }> {
    const params = new URLSearchParams();
    
    if (this.userId) {
      params.set('owner', this.userId.toString());
    }
    
    if (options?.limit) {
      params.set('limit', options.limit.toString());
    }
    
    if (options?.sortBy) {
      params.set('sortBy', options.sortBy);
    }
    
    if (options?.order) {
      params.set('order', options.order);
    }

    const query = params.toString();
    return this.request(`/api/wishlist${query ? `?${query}` : ''}`);
  }

  /**
   * Get a single wishlist item by ID
   */
  async getWishlistItem(id: string): Promise<WishlistItem> {
    return this.request(`/api/wishlist/${id}`);
  }

  /**
   * Add item to wishlist
   */
  async addToWishlist(item: WishlistItem): Promise<{ success: boolean; item: WishlistItem }> {
    const body: any = {
      name: item.name,
      link: item.link,
      currentPrice: item.currentPrice,
      desiredPrice: item.desiredPrice,
      source: item.source,
    };

    if (item.rating) {
      body.rating = item.rating;
    }

    if (this.userId) {
      body.owner = this.userId;
    }

    return this.request('/api/wishlist', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Update wishlist item
   */
  async updateWishlistItem(
    id: string,
    updates: Partial<Omit<WishlistItem, 'id' | 'owner' | 'dateAdded' | 'createdAt' | 'updatedAt'>>
  ): Promise<{ success: boolean; item: WishlistItem }> {
    return this.request(`/api/wishlist/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  /**
   * Remove item from wishlist
   */
  async removeWishlistItem(id: string): Promise<{ success: boolean; message: string }> {
    return this.request(`/api/wishlist/${id}`, {
      method: 'DELETE',
    });
  }

  /**
   * Clear all wishlist items
   */
  async clearWishlist(): Promise<{ success: boolean; deletedCount: number; message: string }> {
    const params = new URLSearchParams();
    
    if (this.userId) {
      params.set('owner', this.userId.toString());
    }

    const query = params.toString();
    return this.request(`/api/wishlist${query ? `?${query}` : ''}`, {
      method: 'DELETE',
    });
  }
}

/**
 * Create a wishlist API client instance
 */
export function createWishlistApiClient(config: WishlistApiConfig): WishlistApiClient {
  return new WishlistApiClient(config);
}
