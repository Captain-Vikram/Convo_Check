import { WhatsAppWebhook } from "@/lib/wa/types";
import { processWhatsAppWebhook } from "./logic";
import { NextRequest, NextResponse } from "next/server";

const VERIFY_TOKEN = "kyaboltelala";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("→ Webhook verified successfully ✔️");
    return new Response(challenge, { status: 200 });
  }

  console.log("→ Webhook verification failed ❌");
  return new Response("Forbidden", { status: 403 });
}

const POST = async (req: NextRequest) => {
  try {
    const body = (await req.json()) as WhatsAppWebhook;
    console.log(JSON.stringify(body));
    const result = await processWhatsAppWebhook(body);

    if (!result.success) {
      return NextResponse.json(
        {
          message: result.error || "Failed to process webhook",
        },
        {
          status: 400,
        }
      );
    }

    return NextResponse.json(
      {
        msg: "Hello World",
      },
      {
        status: 200,
      }
    );
  } catch (error) {
    console.error("Error in POST handler:", error);
    return NextResponse.json(
      {
        message: "Internal server error",
      },
      {
        status: 500,
      }
    );
  }
};

export { POST };