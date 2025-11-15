import { NextRequest } from "next/server";
import callMillProcessMessage from "../../../lib/mill/proxyClient";

/**
 * POST /api/mill-proxy
 * Forwards a normalized message payload to the Mill service and returns the response.
 * Useful to decouple web webhook handling from the Mill HTTP API.
 *
 * Expects JSON body: { sessionId?, userId, phoneNumber?, text, messageId?, maxHistory? }
 * Environment: MILL_API_BASE_URL, MILL_SERVICE_TOKEN
 */
export async function POST(req: Request) {
  try {
    const payload = await req.json();

    if (!process.env.MILL_API_BASE_URL) {
      return new Response(JSON.stringify({ error: "MILL_API_BASE_URL not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Forward to Mill service
    const result = await callMillProcessMessage(payload);

    return new Response(JSON.stringify(result ?? {}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const runtime = "edge";
