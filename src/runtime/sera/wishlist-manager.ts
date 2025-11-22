/**
 * Wishlist Manager - Direct Prisma-backed wishlist utilities used by the CLI stack
 */

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { logger } from '../shared/logger.js';

const prisma = new PrismaClient();
type WishlistRecord = NonNullable<Awaited<ReturnType<typeof prisma.shopping_wishlist.findUnique>>>;

export interface WishlistItem {
  id?: string | undefined;
  owner?: number | undefined;
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

function resolveOwner(owner?: number): number {
  if (typeof owner === 'number' && Number.isFinite(owner) && owner > 0) {
    return Math.trunc(owner);
  }

  const fallbackRaw = process.env.DEV_USER_ID || process.env.DEFAULT_USER_ID || '1';
  const fallback = Number.parseInt(fallbackRaw, 10);
  if (!Number.isFinite(fallback) || fallback <= 0) {
    throw new Error('Wishlist owner is not configured. Set DEV_USER_ID or pass ownerId.');
  }
  return fallback;
}

function toIsoDateOnly(date?: Date | null): string {
  const source = (date ?? new Date()).toISOString();
  return source.slice(0, 10);
}

function mapRecord(record: WishlistRecord): WishlistItem {
  return {
    id: record.id,
    owner: record.owner,
    name: record.name,
    link: record.link,
    currentPrice: record.current_price,
    desiredPrice: record.desired_price,
    rating: record.rating ?? undefined,
    source: record.source,
    dateAdded: toIsoDateOnly(record.date_added),
    createdAt: record.created_at?.toISOString(),
    updatedAt: record.updated_at?.toISOString(),
  };
}

function mapUpdatePayload(data: Partial<WishlistItem>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (typeof data.name === 'string') payload.name = data.name;
  if (typeof data.link === 'string') payload.link = data.link;
  if (typeof data.currentPrice === 'string') payload.current_price = data.currentPrice;
  if (typeof data.desiredPrice === 'string') payload.desired_price = data.desiredPrice;
  if (typeof data.rating === 'string') payload.rating = data.rating;
  if (typeof data.source === 'string') payload.source = data.source;
  if (typeof data.owner === 'number') payload.owner = Math.trunc(data.owner);
  if (typeof data.dateAdded === 'string') payload.date_added = new Date(data.dateAdded);
  return payload;
}
export async function addToWishlist(item: WishlistItem, ownerId?: number): Promise<WishlistItem> {
  const resolvedOwner = resolveOwner(ownerId ?? item.owner);
  try {
    const record: WishlistRecord = await prisma.shopping_wishlist.create({
      data: {
        id: item.id ?? randomUUID(),
        owner: resolvedOwner,
        name: item.name,
        link: item.link,
        current_price: item.currentPrice,
        desired_price: item.desiredPrice,
        rating: item.rating ?? null,
        source: item.source,
        date_added: item.dateAdded ? new Date(item.dateAdded) : new Date(),
      },
    });
    logger.debug('wishlist', `Added product via Prisma: ${item.name}`);
    return mapRecord(record);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('wishlist', `Failed to add item: ${msg}`, error);
    throw new Error(`Failed to add wishlist item: ${msg}`);
  }
}

export async function getWishlist(ownerId?: number): Promise<WishlistItem[]> {
  try {
    const resolvedOwner = resolveOwner(ownerId);
    const records: WishlistRecord[] = await prisma.shopping_wishlist.findMany({
      where: { owner: resolvedOwner },
      orderBy: { date_added: 'desc' },
    });
    return records.map((record) => mapRecord(record));
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('wishlist', `Failed to fetch wishlist: ${msg}`, error);
    throw new Error(`Failed to fetch wishlist: ${msg}`);
  }
}

export async function getWishlistItem(id: string): Promise<WishlistItem | undefined> {
  try {
  const record = await prisma.shopping_wishlist.findUnique({ where: { id } });
  return record ? mapRecord(record as WishlistRecord) : undefined;
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
    const record: WishlistRecord = await prisma.shopping_wishlist.update({
      where: { id },
      data: mapUpdatePayload(updates),
    });
    logger.debug('wishlist', `Updated wishlist item: ${id}`);
    return mapRecord(record);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('wishlist', `Failed to update item: ${msg}`, error);
    throw new Error(`Failed to update wishlist item: ${msg}`);
  }
}

export async function removeWishlistItem(id: string): Promise<boolean> {
  try {
    await prisma.shopping_wishlist.delete({ where: { id } });
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
    const resolvedOwner = resolveOwner(ownerId);
    const result = await prisma.shopping_wishlist.deleteMany({ where: { owner: resolvedOwner } });
    logger.debug('wishlist', `Cleared wishlist: ${result.count} items`);
    return result.count;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('wishlist', `Failed to clear wishlist: ${msg}`, error);
    throw new Error(`Failed to clear wishlist: ${msg}`);
  }
}
export async function disconnectWishlist(): Promise<void> {
  await prisma.$disconnect();
}
