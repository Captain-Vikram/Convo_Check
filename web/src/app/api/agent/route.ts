import processAgentMessage, {
  type AgentEntryRequest,
} from "../../../lib/mill/in-process-adapter";

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as Partial<AgentEntryRequest>;
    const userId = body.userId?.trim();
    const message = body.message ?? "";
    const attachments = Array.isArray(body.attachments) && body.attachments.length > 0
      ? body.attachments
      : undefined;

    if (!userId) {
      return new Response(JSON.stringify({ error: "userId is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!message.trim() && !attachments) {
      return new Response(JSON.stringify({ error: "Provide a message or at least one attachment" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await processAgentMessage({
      userId,
      message,
      attachments,
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
