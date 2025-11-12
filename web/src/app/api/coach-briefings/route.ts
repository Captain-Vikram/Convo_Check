import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getUserContext } from "@/lib/auth-middleware";

const MAX_PAGE_SIZE = 100;

/**
 * GET /api/coach-briefings - Fetch coach briefings for a user
 */
export async function GET(request: Request) {
  const userContext = await getUserContext(request);

  if (!userContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  let ownerFilter: number;

  if (userContext.isService) {
    const ownerParam = url.searchParams.get("owner");
    if (!ownerParam) {
      return NextResponse.json(
        { error: "Missing 'owner' query param for service requests" },
        { status: 400 }
      );
    }
    ownerFilter = Number.parseInt(ownerParam, 10);
    if (!Number.isFinite(ownerFilter)) {
      return NextResponse.json({ error: "Invalid 'owner' query param" }, { status: 400 });
    }
  } else {
    ownerFilter = userContext.userId as number;
  }

  const takeParam = Number.parseInt(url.searchParams.get("limit") ?? "25", 10);
  const take = Number.isFinite(takeParam) ? Math.min(Math.max(takeParam, 1), MAX_PAGE_SIZE) : 25;

  const briefings = await prisma.coach_briefings.findMany({
    where: {
      owner: ownerFilter,
      status: { not: "archived" },
    },
    orderBy: {
      date_created: "desc",
    },
    take,
  });

  return NextResponse.json({ data: briefings });
}

interface CreateCoachBriefingPayload {
  headline: string;
  counsel: string;
  evidence: string;
  insightHash: string;
  trigger?: string;
  metadata?: Record<string, unknown>;
  snapshotId?: number;
  owner?: number; // For service accounts
}

/**
 * POST /api/coach-briefings - Create new coach briefing (from Chatur agent)
 */
export async function POST(request: Request) {
  try {
    const userContext = await getUserContext(request);

    if (!userContext) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as CreateCoachBriefingPayload | null;

    if (!body) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Validate required fields
    if (!body.headline || !body.counsel || !body.evidence || !body.insightHash) {
      return NextResponse.json(
        { error: "Missing required fields: headline, counsel, evidence, insightHash" },
        { status: 400 }
      );
    }

    // Determine owner
    let effectiveOwner: number;
    if (userContext.isService) {
      if (typeof body.owner === "number" && Number.isFinite(body.owner)) {
        effectiveOwner = body.owner;
      } else {
        return NextResponse.json(
          { error: "Service requests must include numeric 'owner'" },
          { status: 400 }
        );
      }
    } else {
      effectiveOwner = userContext.userId as number;
    }

    const now = new Date();

    const created = await prisma.coach_briefings.create({
      data: {
        id: randomUUID(),
        owner: effectiveOwner,
        status: "published",
        headline: body.headline,
        counsel: body.counsel,
        evidence: body.evidence,
        insight_hash: body.insightHash,
        trigger: body.trigger || null,
        metadata: body.metadata ? (body.metadata as any) : undefined,
        snapshot: body.snapshotId || null,
        delivered: false,
        date_created: now,
      },
    });

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    console.error("[POST /api/coach-briefings] Error creating briefing:", error);
    return NextResponse.json(
      { 
        error: "Internal server error", 
        details: error instanceof Error ? error.message : String(error) 
      },
      { status: 500 }
    );
  }
}

