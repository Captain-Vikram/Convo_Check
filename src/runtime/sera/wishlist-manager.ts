/**
 * Wishlist Manager - API-backed product wishlist for Sera agent
 * Saves and manages product wishlists using REST API
 */

import { createWishlistApiClient } from './wishlist-api-client.js';
import type { WishlistApiClient } from './wishlist-api-client.js';
import { logger } from '../shared/logger.js';

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

let apiClient: WishlistApiClient | undefined;

function getApiClient(): WishlistApiClient {
  if (!apiClient) {
    const baseUrl = process.env.WEB_API_URL || process.env.WEB_BASE_URL || 'http://localhost:3000';
    const apiKey =
      process.env.SERVICE_API_TOKEN || process.env.API_KEY || process.env.SERA_SERVICE_API_TOKEN;
    const userId = parseInt(process.env.DEV_USER_ID || process.env.DEFAULT_USER_ID || '2', 10);
    
    if (isNaN(userId) || userId <= 0) {
      throw new Error('Invalid user ID in environment variables');
    }

    if (!apiKey && process.env.DISABLE_AUTH !== '1') {
      throw new Error(
        'Wishlist API requires SERVICE_API_TOKEN (or API_KEY) when auth is enabled. Set SERVICE_API_TOKEN to match the web app.'
      );
    }
    
    apiClient = createWishlistApiClient({
      baseUrl,
      apiKey,
      userId,
    });
  }
  
  return apiClient;
}

export async function addToWishlist(item: WishlistItem, ownerId?: number): Promise<WishlistItem> {
  try {
    const client = getApiClient();
    
    if (ownerId !== undefined) {
      const customClient = createWishlistApiClient({
        baseUrl: process.env.WEB_API_URL || 'http://localhost:3000',
        apiKey: process.env.API_KEY,
        userId: ownerId,
      });
      const result = await customClient.addToWishlist(item);
      logger.debug('wishlist', `Added product via API: ${item.name}`);
      return result.item;
    }
    
    const result = await client.addToWishlist(item);
    logger.debug('wishlist', `Added product via API: ${item.name}`);
    return result.item;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('wishlist', `Failed to add item: ${msg}`, error);
    throw new Error(`Failed to add wishlist item: ${msg}`);
  }
}

export async function getWishlist(ownerId?: number): Promise<WishlistItem[]> {
  try {
    const client = getApiClient();
    
    if (ownerId !== undefined) {
      const customClient = createWishlistApiClient({
        baseUrl: process.env.WEB_API_URL || 'http://localhost:3000',
        apiKey: process.env.API_KEY,
        userId: ownerId,
      });
      const result = await customClient.getWishlist();
      return result.items;
    }
    
    const result = await client.getWishlist();
    return result.items;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('wishlist', `Failed to fetch wishlist: ${msg}`, error);
    throw new Error(`Failed to fetch wishlist: ${msg}`);
  }
}

export async function getWishlistItem(id: string): Promise<WishlistItem | undefined> {
  try {
    const client = getApiClient();
    const item = await client.getWishlistItem(id);
    return item;
  } catch (error) {
    if (error instanceof Error && error.message.includes('404')) {
      return undefined;
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('wishlist', `Failed to fetch wishlist item: ${msg}`, error);
    throw error;
  }
}

export async function updateWishlistItem(
  id: string,
  updates: Partial<Omit<WishlistItem, 'id' | 'dateAdded' | 'createdAt' | 'updatedAt'>>
): Promise<WishlistItem> {
  try {
    const client = getApiClient();
    const result = await client.updateWishlistItem(id, updates);
    logger.debug('wishlist', `Updated wishlist item: ${id}`);
    return result.item;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('wishlist', `Failed to update item: ${msg}`, error);
    throw new Error(`Failed to update wishlist item: ${msg}`);
  }
}

export async function removeWishlistItem(id: string): Promise<boolean> {
  try {
    const client = getApiClient();
    await client.removeWishlistItem(id);
    logger.debug('wishlist', `Removed wishlist item: ${id}`);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('wishlist', `Failed to remove item: ${msg}`, error);
    return false;
  }
}

export async function clearWishlist(ownerId?: number): Promise<number> {
  try {
    const client = getApiClient();
    
    if (ownerId !== undefined) {
      const customClient = createWishlistApiClient({
        baseUrl: process.env.WEB_API_URL || 'http://localhost:3000',
        apiKey: process.env.API_KEY,
        userId: ownerId,
      });
      const result = await customClient.clearWishlist();
      logger.debug('wishlist', `Cleared wishlist:  items`);
      return result.deletedCount;
    }
    
    const result = await client.clearWishlist();
    logger.debug('wishlist', `Cleared wishlist: ${result.deletedCount} items`);
    return result.deletedCount;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('wishlist', `Failed to clear wishlist: ${msg}`, error);
    throw new Error(`Failed to clear wishlist: ${msg}`);
  }
}

export async function disconnectWishlist(): Promise<void> {
  logger.debug('wishlist', 'API client cleanup (no-op)');
}
