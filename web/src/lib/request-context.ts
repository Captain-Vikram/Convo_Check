import { getTokenFromRequest, isAuthDisabled, verifyAuthToken } from "@/lib/auth";

export interface RequestUserContext {
  userId: number;
  role?: string;
  phone?: string;
}

type HeaderLike = Pick<Headers, "get">;

function parseUserId(rawValue: string | null): number | null {
  if (!rawValue) {
    return null;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

export function getUserContextFromHeaders(headers: HeaderLike): RequestUserContext | null {
  const userId = parseUserId(headers.get("x-user-id"));

  if (userId === null) {
    return null;
  }

  const roleHeader = headers.get("x-user-role") ?? undefined;
  const phoneHeader = headers.get("x-user-phone") ?? undefined;

  return {
    userId,
    role: roleHeader,
    phone: phoneHeader,
  };
}

export async function getUserContext(request: Request): Promise<RequestUserContext | null> {
  if (isAuthDisabled()) {
    return {
      userId: parseUserId(process.env.DEV_USER_ID ?? "2") ?? 2,
      role: process.env.DEV_USER_ROLE ?? undefined,
      phone: process.env.DEV_USER_PHONE ?? undefined,
    };
  }

  const headerContext = getUserContextFromHeaders(request.headers);

  if (headerContext) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[request-context] derived from headers", headerContext);
    }
    return headerContext;
  }

  const token = getTokenFromRequest(request);

  if (!token) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[request-context] no token present");
    }
    return null;
  }

  try {
    const payload = await verifyAuthToken(token);
    const userId = parseUserId(typeof payload.sub === "string" ? payload.sub : null);
    if (process.env.NODE_ENV !== "production") {
      console.log("[request-context] payload", payload, "parsed userId", userId);
    }

    if (userId === null) {
      return null;
    }

    return {
      userId,
      role: typeof payload.role === "string" ? payload.role : undefined,
      phone: typeof payload.phone === "string" ? payload.phone : undefined,
    };
  } catch {
    return null;
  }
}
