import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUserContext } from "@/lib/auth-middleware";

const MAX_PAGE_SIZE = 100;

/**
 * GET /api/alerts - Fetch alerts for a user
 * Query params: owner (required for service), status, severity, limit
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

  // Parse optional filters
  const alertStatus = url.searchParams.get("alert_status") || undefined;
  const severity = url.searchParams.get("severity") || undefined;
  const alertType = url.searchParams.get("alert_type") || undefined;

  const takeParam = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const take = Number.isFinite(takeParam) ? Math.min(Math.max(takeParam, 1), MAX_PAGE_SIZE) : 50;

  try {
    const alerts = await prisma.alerts.findMany({
      where: {
        owner: ownerFilter,
        status: { not: "archived" },
        ...(alertStatus && { alert_status: alertStatus }),
        ...(severity && { severity: severity }),
        ...(alertType && { alert_type: alertType }),
      },
      orderBy: {
        date_created: "desc",
      },
      take,
    });

    return NextResponse.json({ data: alerts });
  } catch (error) {
    console.error("[GET /api/alerts] Error fetching alerts:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

interface CreateAlertPayload {
  owner: number;
  alert_type: "anomaly" | "threshold" | "pattern" | "budget";
  severity: "low" | "medium" | "high" | "critical";
  rule_id: string;
  message: string;
  confidence?: number;
  threshold_value?: number;
  actual_value?: number;
  deviation_percentage?: number;
  category?: string;
  merchant?: string;
  transaction_id?: string;
  details?: Record<string, unknown>;
}

/**
 * POST /api/alerts - Create new alert (from alert-manager)
 */
export async function POST(request: Request) {
  try {
    const userContext = await getUserContext(request);

    if (!userContext) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as CreateAlertPayload | null;

    if (!body) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Validate required fields
    if (!body.alert_type || !body.severity || !body.rule_id || !body.message) {
      return NextResponse.json(
        { error: "Missing required fields: alert_type, severity, rule_id, message" },
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

    // Validate enum values
    const validAlertTypes = ["anomaly", "threshold", "pattern", "budget"];
    const validSeverities = ["low", "medium", "high", "critical"];

    if (!validAlertTypes.includes(body.alert_type)) {
      return NextResponse.json(
        { error: `Invalid alert_type. Must be one of: ${validAlertTypes.join(", ")}` },
        { status: 400 }
      );
    }

    if (!validSeverities.includes(body.severity)) {
      return NextResponse.json(
        { error: `Invalid severity. Must be one of: ${validSeverities.join(", ")}` },
        { status: 400 }
      );
    }

    const now = new Date();

    const created = await prisma.alerts.create({
      data: {
        owner: effectiveOwner,
        status: "published",
        alert_type: body.alert_type,
        severity: body.severity,
        rule_id: body.rule_id,
        message: body.message,
        alert_status: "open",
        confidence: body.confidence !== undefined ? body.confidence : undefined,
        threshold_value: body.threshold_value !== undefined ? body.threshold_value : undefined,
        actual_value: body.actual_value !== undefined ? body.actual_value : undefined,
        deviation_percentage:
          body.deviation_percentage !== undefined ? body.deviation_percentage : undefined,
        category: body.category || undefined,
        merchant: body.merchant || undefined,
        transaction_id: body.transaction_id || undefined,
        details: body.details ? (body.details as any) : undefined,
        date_created: now,
        date_updated: now,
      },
    });

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    console.error("[POST /api/alerts] Error creating alert:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

interface UpdateAlertPayload {
  alert_status?: "open" | "acknowledged" | "dismissed";
  acknowledged_by?: string;
}

/**
 * PATCH /api/alerts/:id - Update alert status (acknowledge/dismiss)
 */
export async function PATCH(request: Request) {
  try {
    const userContext = await getUserContext(request);

    if (!userContext) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const alertIdParam = url.searchParams.get("id");

    if (!alertIdParam) {
      return NextResponse.json({ error: "Missing 'id' query param" }, { status: 400 });
    }

    const alertId = Number.parseInt(alertIdParam, 10);
    if (!Number.isFinite(alertId)) {
      return NextResponse.json({ error: "Invalid 'id' query param" }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) as UpdateAlertPayload | null;

    if (!body) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Fetch the alert to verify ownership
    const existing = await prisma.alerts.findUnique({
      where: { id: alertId },
    });

    if (!existing) {
      return NextResponse.json({ error: "Alert not found" }, { status: 404 });
    }

    // Verify ownership (unless service account)
    if (!userContext.isService && existing.owner !== userContext.userId) {
      return NextResponse.json({ error: "Forbidden: You don't own this alert" }, { status: 403 });
    }

    const updateData: any = {};

    if (body.alert_status) {
      const validStatuses = ["open", "acknowledged", "dismissed"];
      if (!validStatuses.includes(body.alert_status)) {
        return NextResponse.json(
          { error: `Invalid alert_status. Must be one of: ${validStatuses.join(", ")}` },
          { status: 400 }
        );
      }
      updateData.alert_status = body.alert_status;

      // Set acknowledged_at if status is changing to acknowledged
      if (body.alert_status === "acknowledged" && existing.alert_status !== "acknowledged") {
        updateData.acknowledged_at = new Date();
        if (body.acknowledged_by) {
          updateData.acknowledged_by = body.acknowledged_by;
        }
      }
    }

    const updated = await prisma.alerts.update({
      where: { id: alertId },
      data: updateData,
    });

    return NextResponse.json({ data: updated }, { status: 200 });
  } catch (error) {
    console.error("[PATCH /api/alerts] Error updating alert:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
