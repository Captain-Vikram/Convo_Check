/**
 * Simple authentication middleware for API routes.
 * Extracts user context once per request to avoid repetition.
 */

const DEV_USER_ID = process.env.DEV_USER_ID
  ? parseInt(process.env.DEV_USER_ID, 10)
  : 1;
const DISABLE_AUTH = process.env.DISABLE_AUTH === "1";

export interface UserContext {
  userId: number;
}

/**
 * Fast inline user context extraction.
 * Returns userId immediately for auth-disabled mode, otherwise validates headers.
 */
export function getUserContext(request: Request): UserContext | null {
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
  if (!token) {
    return null;
  }

  // Basic JWT parsing (no signature verification for speed)
  // WARNING: In production with auth enabled, add proper JWT verification:
  // import { verify } from 'jsonwebtoken';
  // const payload = verify(token, process.env.JWT_SECRET);
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64").toString("utf-8")
    );

    const userId = typeof payload.userId === "number" ? payload.userId : null;
    if (!userId) {
      return null;
    }

    return { userId };
  } catch {
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
    const userContext = getUserContext(request);

    if (!userContext) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    return handler(request, userContext);
  };
}
