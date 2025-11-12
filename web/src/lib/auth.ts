import type { NextRequest } from "next/server";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

const textEncoder = new TextEncoder();

export interface AuthTokenPayload extends JWTPayload {
  sub: string;
  role?: string;
  phone?: string;
}

export function isAuthDisabled(): boolean {
  const flag = process.env.DISABLE_AUTH;
  return flag === "1" || flag?.toLowerCase() === "true";
 }

function getSecretKey(): Uint8Array {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT_SECRET environment variable is not set.");
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(
      "[auth] using JWT secret",
      secret.length >= 4 ? `${secret.slice(0, 2)}***${secret.slice(-2)}` : "<short>",
      "length",
      secret.length,
    );
  }

  return textEncoder.encode(secret);
}

export function getTokenFromRequest(request: NextRequest | Request): string | null {
  const authHeader = request.headers.get("authorization");

  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  if ("cookies" in request) {
    const cookieValue = (request as NextRequest).cookies.get("auth_token")?.value;
    if (cookieValue) {
      return cookieValue;
    }
  }

  return null;
}

export async function verifyAuthToken(token: string): Promise<AuthTokenPayload> {
  if (isAuthDisabled()) {
    return {
      sub: process.env.DEV_USER_ID ?? "2",
    };
  }
  if (process.env.NODE_ENV !== "production") {
    const parts = token.split(".");
    console.log("[auth] verifying token parts", parts, "length", token.length);
  }
  const { payload } = await jwtVerify(token, getSecretKey());
  return payload as AuthTokenPayload;
}

export async function signAuthToken(
  payload: AuthTokenPayload,
  expiresIn: string | number = "1h",
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(getSecretKey());
}
