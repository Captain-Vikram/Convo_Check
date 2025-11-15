import processAgentMessage from "../../../lib/mill/in-process-adapter";

interface AgentApiRequestBody {
  userId?: string;
  message?: string;
  options?: Record<string, unknown>;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as AgentApiRequestBody;
    const userId = body.userId?.trim();
    const message = body.message ?? "";

    if (!userId) {
      return new Response(JSON.stringify({ error: "userId is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!message.trim()) {
      return new Response(JSON.stringify({ error: "message is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await processAgentMessage({
      userId,
      message,
      options: body.options,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const runtime = "nodejs";
