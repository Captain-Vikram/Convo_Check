import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { runAnalyst } from "@/runtime/param/analyst-agent";

const CRON_SECRET = process.env.CRON_SECRET;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest): boolean {
  if (!CRON_SECRET) {
    return false;
  }
  return request.nextUrl.searchParams.get("secret") === CRON_SECRET;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ownerIdParam = request.nextUrl.searchParams.get("ownerId");
  const ownerId = ownerIdParam ? Number(ownerIdParam) : undefined;

  try {
    const result = await runAnalyst({ trigger: "daily", ownerId });
    return NextResponse.json({ success: result.status === "success", result });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
