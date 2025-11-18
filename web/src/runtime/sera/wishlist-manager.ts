import { prisma } from '@/lib/prisma';
import type { WishlistItem } from './types';

type WishlistRecord = NonNullable<Awaited<ReturnType<typeof prisma.shopping_wishlist.findFirst>>>;
type NewWishlistItem = Omit<WishlistItem, 'id' | 'createdAt' | 'updatedAt' | 'owner'> & { owner?: number };

function resolveOwner(owner?: number): number {
  if (typeof owner === 'number' && Number.isFinite(owner) && owner > 0) {
    return Math.trunc(owner);
  }

  const fallbackRaw = process.env.DEV_USER_ID ?? process.env.DEFAULT_USER_ID ?? '1';
  const fallback = Number.parseInt(fallbackRaw, 10);
  if (Number.isNaN(fallback) || fallback <= 0) {
    throw new Error('Wishlist owner is not configured. Set DEV_USER_ID or provide an owner parameter.');
  }
  return fallback;
}

function toIsoDateOnly(date?: Date | null): string {
  const source = (date ?? new Date()).toISOString();
  return source.slice(0, 10);
}

function mapRecord(record: WishlistRecord): WishlistItem {
  const dateAdded = toIsoDateOnly(record.date_added);
  return {
    id: record.id,
    owner: record.owner,
    name: record.name,
    link: record.link,
    currentPrice: record.current_price,
    desiredPrice: record.desired_price,
    rating: record.rating ?? undefined,
    source: record.source,
    dateAdded,
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

export async function getWishlist(owner?: number): Promise<WishlistItem[]> {
  const ownerId = resolveOwner(owner);
  const records = await prisma.shopping_wishlist.findMany({
    where: { owner: ownerId },
    orderBy: { date_added: 'desc' },
  });
  return records.map(mapRecord);
}

export async function addToWishlist(item: NewWishlistItem): Promise<WishlistItem> {
  const ownerId = resolveOwner(item.owner);
  const { randomUUID } = await import('node:crypto');
  const record = await prisma.shopping_wishlist.create({
    data: {
      id: randomUUID(),
      owner: ownerId,
      name: item.name,
      link: item.link,
      current_price: item.currentPrice,
      desired_price: item.desiredPrice,
      rating: item.rating ?? null,
      source: item.source,
      date_added: item.dateAdded ? new Date(item.dateAdded) : new Date(),
    },
  });
  return mapRecord(record);
}

export async function updateWishlistItem(id: string, data: Partial<WishlistItem>): Promise<WishlistItem> {
  const record = await prisma.shopping_wishlist.update({
    where: { id },
    data: mapUpdatePayload(data),
  });
  return mapRecord(record);
}

export async function removeWishlistItem(id: string): Promise<WishlistItem | null> {
  try {
    const record = await prisma.shopping_wishlist.delete({ where: { id } });
    return mapRecord(record);
  } catch (error) {
    if (isRecordNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function clearWishlist(owner?: number): Promise<number> {
  const ownerId = resolveOwner(owner);
  const result = await prisma.shopping_wishlist.deleteMany({ where: { owner: ownerId } });
  return result.count;
}

function isRecordNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2025'
  );
}

export type { WishlistItem };
