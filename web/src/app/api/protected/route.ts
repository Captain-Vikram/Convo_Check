import { NextRequest, NextResponse } from "next/server";
import { getTokenFromRequest, isAuthDisabled, verifyAuthToken } from "@/lib/auth";

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    console.log("[protected] headers", Array.from(request.headers.entries()));
  }
  try {
    if (isAuthDisabled()) {
      if (process.env.NODE_ENV !== "production") {
        console.log("[protected] auth disabled returning dev context");
      }
      return NextResponse.json({
        message: "Protected resource accessed",
        subject: process.env.DEV_USER_ID ?? "2",
        role: process.env.DEV_USER_ROLE ?? null,
        issuedAt: null,
        expiresAt: null,
      });
    }

    const token = getTokenFromRequest(request);

    if (!token) {
      if (process.env.NODE_ENV !== "production") {
        console.log("[protected] no token extracted");
      }
      return NextResponse.json({ error: "Missing token" }, { status: 401 });
    }

    const payload = await verifyAuthToken(token);
    if (process.env.NODE_ENV !== "production") {
      console.log("[protected] payload", payload);
    }

    return NextResponse.json({
      message: "Protected resource accessed",
      subject: payload.sub,
      role: payload.role ?? null,
      issuedAt: payload.iat ?? null,
      expiresAt: payload.exp ?? null,
    });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[protected] verification failed", error);
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unauthorized" },
      { status: 401 },
    );
  }
}
