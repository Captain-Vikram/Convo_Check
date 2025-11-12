/**
 * Simple authentication middleware for API routes.
 * Extracts user context once per request to avoid repetition.
 */

import { jwtVerify } from "jose";

const DEV_USER_ID = process.env.DEV_USER_ID
  ? parseInt(process.env.DEV_USER_ID, 10)
  : 1;
const DISABLE_AUTH = process.env.DISABLE_AUTH === "1";
const SERVICE_API_TOKEN = process.env.SERVICE_API_TOKEN ?? null;
const JWT_SECRET = process.env.JWT_SECRET;

export interface UserContext {
  // Present when an actual user authenticated via JWT
  userId?: number;
  // Present when a trusted service token was used
  isService?: boolean;
  serviceName?: string;
}

/**
 * Fast inline user context extraction.
 * Returns userId immediately for auth-disabled mode, otherwise validates headers.
 */
export async function getUserContext(request: Request): Promise<UserContext | null> {
  // Fast path: auth disabled
  if (DISABLE_AUTH) {
    return { userId: DEV_USER_ID };
  }

  // Extract Authorization header
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7);
  if (!token) return null;

  // If the token exactly matches the configured SERVICE_API_TOKEN allow service access
  if (SERVICE_API_TOKEN && token === SERVICE_API_TOKEN) {
    return { isService: true, serviceName: "internal" };
  }

  // JWT verification with signature check
  if (!JWT_SECRET) {
    console.error("[auth-middleware] JWT_SECRET not configured; cannot verify user tokens");
    return null;
  }

  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(JWT_SECRET)
    );

    const userId = payload.sub ? parseInt(String(payload.sub), 10) : null;
    if (!userId || isNaN(userId)) {
      return null;
    }

    return { userId };
  } catch (error) {
    // JWT verification failed (expired, invalid signature, etc.)
    return null;
  }
}

/**
 * Middleware wrapper that injects user context into request.
 * Use this if you need to attach context to request object.
 */
export function withAuth(
  handler: (request: Request, context: UserContext) => Promise<Response>
) {
  return async (request: Request): Promise<Response> => {
    const userContext = await getUserContext(request);

    if (!userContext) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    return handler(request, userContext);
  };
}
