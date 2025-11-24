import { NextRequest, NextResponse } from "next/server";
import { fetchHabitInsights, persistSyntheticHabitInsight } from "@/runtime/dev/dev-agent";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const ownerRaw = url.searchParams.get("owner");
    const ownerId = ownerRaw ? Number(ownerRaw) : undefined;

    if (!ownerId || Number.isNaN(ownerId)) {
      return NextResponse.json({ error: "missing_owner", message: "owner query param is required" }, { status: 400 });
    }

    const insights = await fetchHabitInsights(ownerId, 10);
    return NextResponse.json({ insights });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "server_error", message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "invalid_body", message: "Expected JSON body" }, { status: 400 });
    }

    const ownerId = Number((body as any).owner);
    const insight = (body as any).insight;

    if (!ownerId || Number.isNaN(ownerId) || !insight) {
      return NextResponse.json({ error: "missing_fields", message: "owner and insight are required" }, { status: 400 });
    }

    const persisted = await persistSyntheticHabitInsight(ownerId, insight as any);
    if (!persisted) {
      return NextResponse.json({ error: "persist_failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, insight: persisted });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "server_error", message }, { status: 500 });
  }
}
