import { NextResponse, type NextRequest } from "next/server";
import { getTokenFromRequest, verifyAuthToken } from "@/lib/auth";

const PUBLIC_PATH_PREFIXES = ["/api/auth", "/api/public"];

export async function middleware(request: NextRequest) {
  if (request.method === "OPTIONS") {
    return NextResponse.next();
  }

  if (PUBLIC_PATH_PREFIXES.some((prefix) => request.nextUrl.pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const authDisabled =
    process.env.DISABLE_AUTH === "1" || process.env.DISABLE_AUTH?.toLowerCase() === "true";

  if (authDisabled || request.headers.get("host")?.startsWith("localhost")) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[middleware] bypassing auth for", request.nextUrl.pathname);
    }
    const requestHeaders = new Headers(request.headers);
    const fallbackUserId = process.env.DEV_USER_ID ?? "2";
    requestHeaders.set("x-user-id", fallbackUserId);

    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const token = getTokenFromRequest(request);

  if (!token) {
    return NextResponse.json({ error: "Missing authorization token" }, { status: 401 });
  }

  try {
    const payload = await verifyAuthToken(token);
    const requestHeaders = new Headers(request.headers);

    if (payload.sub) {
      requestHeaders.set("x-user-id", payload.sub);
    }

    if (payload.role) {
      requestHeaders.set("x-user-role", String(payload.role));
    }

    return NextResponse.next({ request: { headers: requestHeaders } });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[middleware] JWT verification failed", error);
    }

    const status = error instanceof Error && error.message.includes("JWT_SECRET") ? 500 : 401;

    return NextResponse.json(
      { error: status === 500 ? "Server configuration error" : "Invalid or expired token" },
      { status },
    );
  }
}

export const config = {
  matcher: ["/api/:path*"],
};
