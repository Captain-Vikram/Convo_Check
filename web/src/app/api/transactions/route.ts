import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { getUserContext } from "@/lib/auth-middleware";

const MAX_PAGE_SIZE = 100;
const ALLOWED_TRANSACTION_TYPES = new Set(["credit", "debit", "refund", "other"]);

export async function GET(request: Request) {
  const userContext = await getUserContext(request);

  if (!userContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Determine which owner's transactions to fetch. Services must specify `owner` query param.
  const url = new URL(request.url);
  let ownerFilter: number | undefined = undefined;
  if (userContext.isService) {
    const ownerParam = url.searchParams.get("owner");
    if (!ownerParam) {
      return NextResponse.json({ error: "Missing 'owner' query param for service requests" }, { status: 400 });
    }
    const parsed = Number.parseInt(ownerParam, 10);
    if (!Number.isFinite(parsed)) {
      return NextResponse.json({ error: "Invalid 'owner' query param" }, { status: 400 });
    }
    ownerFilter = parsed;
  } else {
    ownerFilter = userContext.userId as number;
  }
  const takeParam = Number.parseInt(url.searchParams.get("limit") ?? "25", 10);
  const cursor = url.searchParams.get("cursor");
  const take = Number.isFinite(takeParam) ? Math.min(Math.max(takeParam, 1), MAX_PAGE_SIZE) : 25;

  const startDateParam = url.searchParams.get("startDate");
  const endDateParam = url.searchParams.get("endDate");
  const typeParamRaw = url.searchParams.get("type");
  const typeParam = typeParamRaw ? typeParamRaw.trim().toLowerCase() : null;

  if (typeParam && !ALLOWED_TRANSACTION_TYPES.has(typeParam)) {
    return NextResponse.json({ error: "'type' must be one of credit|debit|refund|other" }, { status: 400 });
  }

  const dateFilter: { gte?: Date; lte?: Date } = {};

  if (startDateParam) {
    const startDate = new Date(startDateParam);
    if (Number.isNaN(startDate.getTime())) {
      return NextResponse.json({ error: "'startDate' must be an ISO-8601 timestamp" }, { status: 400 });
    }
    dateFilter.gte = startDate;
  }

  if (endDateParam) {
    const endDate = new Date(endDateParam);
    if (Number.isNaN(endDate.getTime())) {
      return NextResponse.json({ error: "'endDate' must be an ISO-8601 timestamp" }, { status: 400 });
    }
    dateFilter.lte = endDate;
  }

  if (cursor) {
    const cursorOwner = await prisma.tranasctions.findUnique({
      where: { id: cursor },
      select: { owner: true },
    });

    if (!cursorOwner || cursorOwner.owner !== ownerFilter) {
      return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
    }
  }

  const transactions = await prisma.tranasctions.findMany({
    where: {
      owner: ownerFilter,
      ...(Object.keys(dateFilter).length > 0
        ? { date_of_transaction: dateFilter }
        : {}),
  ...(typeParam ? { type: typeParam } : {}),
    },
    orderBy: [
      { date_of_transaction: "desc" },
      { date_created: "desc" },
      { id: "desc" },
    ],
    take,
    ...(cursor
      ? {
          skip: 1,
          cursor: { id: cursor },
        }
      : {}),
    include: {
      sms_messages: {
        select: {
          id: true,
          raw_text: true,
          sender_name: true,
          time: true,
          status: true,
        },
      },
    },
  });

  const nextCursor = transactions.length === take ? transactions[transactions.length - 1]?.id ?? null : null;

  return NextResponse.json({ data: transactions, nextCursor });
}

interface CreateTransactionPayload {
  amount: number;
  type: "credit" | "debit" | "refund" | "other";
  category?: string;
  description?: string;
  medium?: string;
  originalSmsId?: number;
  owner?: number; // optional - only allowed when authenticated as service
  currency?: string;
  targetParty?: string;
  eventDate?: string;
}

export async function POST(request: Request) {
  const userContext = await getUserContext(request);

  if (!userContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // effectiveOwner will be resolved after parsing the body below (allows service to provide owner or infer from originalSmsId)

  const body = (await request.json().catch(() => null)) as CreateTransactionPayload | null;

  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.amount !== "number" || Number.isNaN(body.amount) || !Number.isFinite(body.amount)) {
    return NextResponse.json({ error: "'amount' must be a finite number" }, { status: 400 });
  }

  if (body.amount <= 0) {
    return NextResponse.json({ error: "'amount' must be greater than zero" }, { status: 400 });
  }

  const normalizedType = typeof body.type === "string" ? body.type.trim().toLowerCase() : "";

  if (!normalizedType || !ALLOWED_TRANSACTION_TYPES.has(normalizedType)) {
    return NextResponse.json({ error: "'type' must be one of credit|debit|refund|other" }, { status: 400 });
  }

  const now = new Date();
  const eventDate = body.eventDate ? new Date(body.eventDate) : now;

  if (Number.isNaN(eventDate.getTime())) {
    return NextResponse.json({ error: "'eventDate' must be a valid ISO timestamp" }, { status: 400 });
  }

  const normalizedCurrency =
    typeof body.currency === "string" && body.currency.trim().length > 0
      ? body.currency.trim().toUpperCase()
      : "INR";
  const normalizedCategory = typeof body.category === "string" ? body.category.trim() : "";
  const normalizedDescription = typeof body.description === "string" ? body.description.trim() : "";
  const normalizedMedium = typeof body.medium === "string" ? body.medium.trim() : "";
  const normalizedTargetParty = typeof body.targetParty === "string" ? body.targetParty.trim() : "";

  let smsMessageId: number | null = null;

  // Resolve effective owner. If authenticated as a service, allow owner in body or infer from originalSmsId.
  let effectiveOwner: number;
  if (userContext.isService) {
    if (typeof body.owner === "number" && Number.isFinite(body.owner)) {
      effectiveOwner = Number(body.owner);
    } else if (typeof body.originalSmsId === "number") {
      const ownerRecord = await prisma.sms_messages.findUnique({ where: { id: body.originalSmsId }, select: { owner: true } });
      if (!ownerRecord) {
        return NextResponse.json({ error: "Invalid SMS reference" }, { status: 400 });
      }
  effectiveOwner = Number(ownerRecord.owner);
    } else {
      return NextResponse.json({ error: "Service requests must include numeric 'owner' in body or originalSmsId to infer owner" }, { status: 400 });
    }
  } else {
    effectiveOwner = userContext.userId as number;
  }

  if (typeof body.originalSmsId === "number") {
    const smsRecord = await prisma.sms_messages.findUnique({
      where: { id: body.originalSmsId },
      select: { owner: true },
    });

    if (!smsRecord || smsRecord.owner !== effectiveOwner) {
      return NextResponse.json({ error: "Invalid SMS reference" }, { status: 400 });
    }

    smsMessageId = body.originalSmsId;
  }

  const created = await prisma.tranasctions.create({
    data: {
      id: randomUUID(),
      status: "active",
      amount: body.amount,
  type: normalizedType,
      category: normalizedCategory.length > 0 ? normalizedCategory : null,
      description: normalizedDescription.length > 0 ? normalizedDescription : null,
      medium: normalizedMedium.length > 0 ? normalizedMedium : null,
      owner: effectiveOwner,
      currency: normalizedCurrency,
      target_party: normalizedTargetParty.length > 0 ? normalizedTargetParty : null,
      date_created: now,
      date_updated: now,
      date_of_transaction: eventDate,
      original_sms: smsMessageId,
    },
  });

  return NextResponse.json({ data: created }, { status: 201 });
}
