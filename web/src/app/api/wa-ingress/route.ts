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

const lmao = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "1306973550907006",
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "919819245576",
              phone_number_id: "760703340470175",
            },
            contacts: [{ profile: { name: "Yash" }, wa_id: "919324612161" }],
            messages: [
              {
                from: "919324612161",
                id: "wamid.HBgMOTE5MzI0NjEyMTYxFQIAEhggQUM2NERDQzhCNjU1N0NCOThBQ0MwOEI2MkZGOTFDQjgA",
                timestamp: "1764233844",
                type: "image",
                image: {
                  mime_type: "image/jpeg",
                  sha256: "zFn4nOtnqUWoS6t7Xo6+NI1B7shvfKppqkikwWPS8+o=",
                  id: "667221642994050",
                },
              },
            ],
          },
          field: "messages",
        },
      ],
    },
  ],
};
