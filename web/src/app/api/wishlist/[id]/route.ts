import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { getUserContext } from "@/lib/auth-middleware";

/**
 * GET /api/wishlist/[id]
 * Fetch a single wishlist item by ID
 */
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const userContext = await getUserContext(request);

  if (!userContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = params;

  try {
    const item = await prisma.shopping_wishlist.findUnique({
      where: { id },
    });

    if (!item) {
      return NextResponse.json(
        { error: "Wishlist item not found" },
        { status: 404 }
      );
    }

    // Authorization: Only owner or service accounts can access
    if (!userContext.isService && item.owner !== userContext.userId) {
      return NextResponse.json(
        { error: "Forbidden: You don't own this wishlist item" },
        { status: 403 }
      );
    }

    return NextResponse.json({
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
    });
  } catch (error) {
    console.error("[API] Error fetching wishlist item:", error);
    return NextResponse.json(
      { error: "Failed to fetch wishlist item" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/wishlist/[id]
 * Update a wishlist item
 * 
 * Body (all optional):
 * {
 *   name?: string,
 *   link?: string,
 *   currentPrice?: string,
 *   desiredPrice?: string,
 *   rating?: string,
 *   source?: string
 * }
 */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const userContext = await getUserContext(request);

  if (!userContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = params;

  let body: {
    name?: string;
    link?: string;
    currentPrice?: string;
    desiredPrice?: string;
    rating?: string;
    source?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Check if item exists and user has permission
  try {
    const existing = await prisma.shopping_wishlist.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Wishlist item not found" },
        { status: 404 }
      );
    }

    // Authorization
    if (!userContext.isService && existing.owner !== userContext.userId) {
      return NextResponse.json(
        { error: "Forbidden: You don't own this wishlist item" },
        { status: 403 }
      );
    }

    // Build update data
    const updateData: Record<string, any> = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.link !== undefined) updateData.link = body.link;
    if (body.currentPrice !== undefined) updateData.current_price = body.currentPrice;
    if (body.desiredPrice !== undefined) updateData.desired_price = body.desiredPrice;
    if (body.rating !== undefined) updateData.rating = body.rating || null;
    if (body.source !== undefined) updateData.source = body.source;

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: "No fields to update" },
        { status: 400 }
      );
    }

    const updated = await prisma.shopping_wishlist.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({
      success: true,
      item: {
        id: updated.id,
        owner: updated.owner,
        name: updated.name,
        link: updated.link,
        currentPrice: updated.current_price,
        desiredPrice: updated.desired_price,
        rating: updated.rating,
        source: updated.source,
        dateAdded: updated.date_added.toISOString(),
        createdAt: updated.created_at.toISOString(),
        updatedAt: updated.updated_at.toISOString(),
      },
    });
  } catch (error) {
    console.error("[API] Error updating wishlist item:", error);
    return NextResponse.json(
      { error: "Failed to update wishlist item" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/wishlist/[id]
 * Remove a single wishlist item
 */
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const userContext = await getUserContext(request);

  if (!userContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = params;

  try {
    const existing = await prisma.shopping_wishlist.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Wishlist item not found" },
        { status: 404 }
      );
    }

    // Authorization
    if (!userContext.isService && existing.owner !== userContext.userId) {
      return NextResponse.json(
        { error: "Forbidden: You don't own this wishlist item" },
        { status: 403 }
      );
    }

    await prisma.shopping_wishlist.delete({
      where: { id },
    });

    return NextResponse.json({
      success: true,
      message: "Wishlist item removed",
      deletedItem: {
        id: existing.id,
        name: existing.name,
      },
    });
  } catch (error) {
    console.error("[API] Error deleting wishlist item:", error);
    return NextResponse.json(
      { error: "Failed to delete wishlist item" },
      { status: 500 }
    );
  }
}
