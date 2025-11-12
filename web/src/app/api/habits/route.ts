import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUserContext } from "@/lib/auth-middleware";

const MAX_PAGE_SIZE = 100;

/**
 * GET /api/habits - Fetch habit insights for a user
 * Query params: owner (required for service), limit, cursor
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

  const habits = await prisma.habit_insights.findMany({
    where: {
      owner: ownerFilter,
      status: { not: "archived" },
    },
    orderBy: {
      recorded_at: "desc",
    },
    take,
  });

  return NextResponse.json({ data: habits });
}

interface CreateHabitPayload {
  habitLabel: string;
  evidence: string;
  counsel: string;
  fullText: string;
  metrics?: Record<string, unknown>;
  recentTransactions?: Record<string, unknown>;
  transactionId?: string;
  owner?: number; // For service accounts
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeMetrics(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  const stringKeys = ["habitType", "spendingPattern", "frequency", "riskLevel"];
  for (const key of stringKeys) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      sanitized[key] = raw.trim();
    }
  }

  const numericKeys = ["averageAmount", "totalSpent", "transactionCount"];
  for (const key of numericKeys) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      sanitized[key] = raw;
    } else if (typeof raw === "string") {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed)) {
        sanitized[key] = parsed;
      }
    }
  }

  const extras = ["suggestions", "additionalNotes"];
  for (const key of extras) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      sanitized[key] = raw.trim();
    }
  }

  return sanitized;
}

function sanitizeRecentTransactions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  const habitId = record.habitId;
  if (typeof habitId === "string" && habitId.trim().length > 0) {
    sanitized.habitId = habitId.trim();
  }

  const targetParty = record.targetParty;
  if (typeof targetParty === "string" && targetParty.trim().length > 0) {
    sanitized.targetParty = targetParty.trim();
  }

  const category = record.category;
  if (typeof category === "string" && category.trim().length > 0) {
    sanitized.category = category.trim();
  }

  const recent = record.recentTransactions;
  if (Array.isArray(recent)) {
    const cleaned = recent
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim());
    if (cleaned.length > 0) {
      sanitized.recentTransactions = cleaned;
    }
  } else if (typeof recent === "string" && recent.trim().length > 0) {
    sanitized.recentTransactions = [recent.trim()];
  }

  const previousHabitId = record.previousHabitId;
  if (typeof previousHabitId === "string" && previousHabitId.trim().length > 0) {
    sanitized.previousHabitId = previousHabitId.trim();
  }

  return sanitized;
}

function sanitizeTransactionId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return UUID_REGEX.test(trimmed) ? trimmed : trimmed;
}

/**
 * POST /api/habits - Create new habit insight (from Param agent)
 */
export async function POST(request: Request) {
  try {
    const userContext = await getUserContext(request);

    if (!userContext) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as CreateHabitPayload | null;

    if (!body) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Validate required fields
    if (!body.habitLabel || !body.evidence || !body.counsel || !body.fullText) {
      return NextResponse.json(
        { error: "Missing required fields: habitLabel, evidence, counsel, fullText" },
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

    // Generate habit_id hash
    const crypto = await import("node:crypto");
    const content = `${body.habitLabel}|${body.evidence}|${body.counsel}`;
    const habitId = crypto.createHash("sha256").update(content).digest("hex").substring(0, 32);

    // Check if already exists
    const existing = await prisma.habit_insights.findFirst({
      where: { habit_id: habitId, owner: effectiveOwner },
    });

    if (existing) {
      return NextResponse.json({ data: existing }, { status: 200 });
    }

    const now = new Date();

    const metrics = sanitizeMetrics(body.metrics);
    const recentTransactions = sanitizeRecentTransactions(body.recentTransactions);
    const transactionId = sanitizeTransactionId(body.transactionId);

    const created = await prisma.habit_insights.create({
      data: {
        habit_id: habitId,
        owner: effectiveOwner,
        status: "published",
        habit_label: body.habitLabel,
        evidence: body.evidence,
        counsel: body.counsel,
        full_text: body.fullText,
        metrics: (metrics as any) ?? {},
        recent_transactions: (recentTransactions as any) ?? {},
        transaction_id: transactionId,
        recorded_at: now,
        date_created: now,
      },
    });

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    console.error("[POST /api/habits] Error creating habit insight:", error);
    return NextResponse.json(
      { 
        error: "Internal server error", 
        details: error instanceof Error ? error.message : String(error) 
      },
      { status: 500 }
    );
  }
}
