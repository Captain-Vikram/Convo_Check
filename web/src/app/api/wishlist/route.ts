import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { getUserContext } from "@/lib/auth-middleware";

/**
 * GET /api/wishlist
 * Fetch all wishlist items for a user
 * 
 * Query params:
 * - owner: number (required for service accounts)
 * - limit: number (default 50, max 100)
 * - sortBy: 'date_added' | 'current_price' | 'name' (default: 'date_added')
 * - order: 'asc' | 'desc' (default: 'desc')
 */
export async function GET(request: Request) {
  const userContext = await getUserContext(request);

  if (!userContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  
  // Determine owner
  let ownerFilter: number | undefined = undefined;
  if (userContext.isService) {
    const ownerParam = url.searchParams.get("owner");
    if (!ownerParam) {
      return NextResponse.json(
        { error: "Missing 'owner' query param for service requests" },
        { status: 400 }
      );
    }
    const parsed = Number.parseInt(ownerParam, 10);
    if (!Number.isFinite(parsed)) {
      return NextResponse.json(
        { error: "Invalid 'owner' query param" },
        { status: 400 }
      );
    }
    ownerFilter = parsed;
  } else {
    ownerFilter = userContext.userId as number;
  }

  // Pagination
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(limitParam) 
    ? Math.min(Math.max(limitParam, 1), 100) 
    : 50;

  // Sorting
  const sortBy = url.searchParams.get("sortBy") ?? "date_added";
  const order = url.searchParams.get("order") ?? "desc";

  const allowedSortFields = ["date_added", "current_price", "name"];
  if (!allowedSortFields.includes(sortBy)) {
    return NextResponse.json(
      { error: `'sortBy' must be one of: ${allowedSortFields.join(", ")}` },
      { status: 400 }
    );
  }

  if (order !== "asc" && order !== "desc") {
    return NextResponse.json(
      { error: "'order' must be 'asc' or 'desc'" },
      { status: 400 }
    );
  }

  try {
    const items = await prisma.shopping_wishlist.findMany({
      where: { owner: ownerFilter },
      orderBy: { [sortBy]: order },
      take: limit,
    });

    // Transform to camelCase for API response
    const formatted = items.map((item) => ({
      id: item.id,
      owner: item.owner,
      name: item.name,
      link: item.link,
      currentPrice: item.current_price,
      desiredPrice: item.desired_price,
      rating: item.rating,
      source: item.source,
      dateAdded: item.date_added.toISOString(),
      createdAt: item.created_at.toISOString(),
      updatedAt: item.updated_at.toISOString(),
    }));

    return NextResponse.json({
      items: formatted,
      count: formatted.length,
      owner: ownerFilter,
    });
  } catch (error) {
    console.error("[API] Error fetching wishlist:", error);
    return NextResponse.json(
      { error: "Failed to fetch wishlist items" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/wishlist
 * Add a new item to wishlist
 * 
 * Body:
 * {
 *   name: string,
 *   link: string,
 *   currentPrice: string,
 *   desiredPrice: string,
 *   rating?: string,
 *   source: string,
 *   owner?: number (for service accounts)
 * }
 */
export async function POST(request: Request) {
  const userContext = await getUserContext(request);

  if (!userContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    name: string;
    link: string;
    currentPrice: string;
    desiredPrice: string;
    rating?: string;
    source: string;
    owner?: number;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate required fields
  if (!body.name || !body.link || !body.currentPrice || !body.desiredPrice || !body.source) {
    return NextResponse.json(
      {
        error: "Missing required fields: name, link, currentPrice, desiredPrice, source",
      },
      { status: 400 }
    );
  }

  // Determine owner
  let owner: number;
  if (userContext.isService) {
    if (!body.owner) {
      return NextResponse.json(
        { error: "Service accounts must provide 'owner' in request body" },
        { status: 400 }
      );
    }
    owner = body.owner;
  } else {
    owner = userContext.userId as number;
  }

  try {
    const created = await prisma.shopping_wishlist.create({
      data: {
        id: randomUUID(),
        owner,
        name: body.name,
        link: body.link,
        current_price: body.currentPrice,
        desired_price: body.desiredPrice,
        rating: body.rating || null,
        source: body.source,
      },
    });

    return NextResponse.json(
      {
        success: true,
        item: {
          id: created.id,
          owner: created.owner,
          name: created.name,
          link: created.link,
          currentPrice: created.current_price,
          desiredPrice: created.desired_price,
          rating: created.rating,
          source: created.source,
          dateAdded: created.date_added.toISOString(),
          createdAt: created.created_at.toISOString(),
          updatedAt: created.updated_at.toISOString(),
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[API] Error adding wishlist item:", error);
    return NextResponse.json(
      { error: "Failed to add wishlist item" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/wishlist
 * Clear all wishlist items for a user
 * 
 * Query params:
 * - owner: number (required for service accounts)
 */
export async function DELETE(request: Request) {
  const userContext = await getUserContext(request);

  if (!userContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);

  // Determine owner
  let ownerFilter: number | undefined = undefined;
  if (userContext.isService) {
    const ownerParam = url.searchParams.get("owner");
    if (!ownerParam) {
      return NextResponse.json(
        { error: "Missing 'owner' query param for service requests" },
        { status: 400 }
      );
    }
    const parsed = Number.parseInt(ownerParam, 10);
    if (!Number.isFinite(parsed)) {
      return NextResponse.json(
        { error: "Invalid 'owner' query param" },
        { status: 400 }
      );
    }
    ownerFilter = parsed;
  } else {
    ownerFilter = userContext.userId as number;
  }

  try {
    const result = await prisma.shopping_wishlist.deleteMany({
      where: { owner: ownerFilter },
    });

    return NextResponse.json({
      success: true,
      deletedCount: result.count,
      message: `Cleared ${result.count} items from wishlist`,
    });
  } catch (error) {
    console.error("[API] Error clearing wishlist:", error);
    return NextResponse.json(
      { error: "Failed to clear wishlist" },
      { status: 500 }
    );
  }
}
