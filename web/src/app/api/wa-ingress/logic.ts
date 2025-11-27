import processAgentMessage from "@/lib/mill/in-process-adapter";
import { prisma } from "@/lib/prisma";
import { WhatsAppWebhook } from "@/lib/wa/types";
import { getPublicMediaUrlFromWhatsApp } from "@/lib/wa/whatsAppMedia";
import { wacloud } from "@/lib/wacloud";
import { AgentAttachmentType } from "@/runtime/shared/multimodal";
import { randomUUID } from "crypto";

interface ProcessWhatsAppWebhookResult {
  success: boolean;
  message?: string;
  error?: string;
}

export async function processWhatsAppWebhook(
  body: WhatsAppWebhook
): Promise<ProcessWhatsAppWebhookResult> {
  try {
    const phoneNumber = body.entry[0].changes[0].value.messages[0].from;
    const wamid = body.entry[0].changes[0].value.messages[0].id;
    let text = body.entry[0].changes[0].value.messages[0].text?.body;

    let mediaURL = "";
    let mimeType = "";
    let mediaType = "";

    if (
      body.entry[0].changes[0].value.messages[0].type == "image" &&
      body.entry[0].changes[0].value.messages[0].image
    ) {
      const imageBase64 = await getPublicMediaUrlFromWhatsApp({
        id: body.entry[0].changes[0].value.messages[0].image?.id,
        mime_type: body.entry[0].changes[0].value.messages[0].image.mime_type,
        sha256: body.entry[0].changes[0].value.messages[0].image.sha256,
        type: "image",
      });
      if (imageBase64) {
        mimeType = imageBase64.mimeType;
        mediaURL = imageBase64.url;
        text = body.entry[0].changes[0].value.messages[0].image.caption || text;
        mediaType = "image";
      }
    }

    if (
      body.entry[0].changes[0].value.messages[0].type == "audio" &&
      body.entry[0].changes[0].value.messages[0].audio
    ) {
      const audio = await getPublicMediaUrlFromWhatsApp({
        id: body.entry[0].changes[0].value.messages[0].audio?.id,
        mime_type: body.entry[0].changes[0].value.messages[0].audio.mime_type,
        sha256: body.entry[0].changes[0].value.messages[0].audio.sha256,
        type: "audio",
      });
      if (audio) {
        mimeType = audio.mimeType;
        mediaURL = audio.url;
        text = "I have attached an audio recording"
        mediaType = "audio";
      }
    }

    console.log({
      phoneNumber: phoneNumber,
      wamid: wamid,
      text: text,
    });

    // GET USER ID FROM THE DB
    // CREATE USER IF NOT PRESENT IN DB

    let userId = 0;

    const user = await prisma.users.findFirst({
      where: {
        whatsapp_number: phoneNumber,
      },
    });

    if (user) {
      userId = user.id;
    } else {
      const newUser = await prisma.users.create({
        data: {
          whatsapp_number: phoneNumber,
          date_created: new Date(),
        },
      });
      if (newUser) {
        userId = newUser.id;
      }
    }

    // STORE THE MESSAGE IN DB

    const message = await prisma.wa_messages.create({
      data: {
        id: randomUUID(),
        date_created: new Date(),
        date_updated: new Date(),
        text: text,
        wamid: wamid,
        users: {
          connect: {
            id: userId,
          },
        },
      },
    });

    if (!message) {
      return {
        success: false,
        error: "Failed to save message in DB",
      };
    }

    console.log({
      userId: String(userId),
      message: text,
      attachments: [
        {
          mimeType: mimeType,
          type: mediaType,
          url: mediaURL,
          name: "Media",
        },
      ],
    });

    processAgentMessage({
      userId: String(userId),
      message: text,
      attachments: [
        {
          mimeType: mimeType,
          type: mediaType as AgentAttachmentType,
          url: mediaURL,
          name: "Image data",
        },
      ],
    })
      .then(async (res) => {
        console.log(res);

        // console.log({
        //   to: phoneNumber,
        //   message: res.message || "HELLO WORLD",
        //   enableLinkPreview: false,
        // });

        // wacloud.sendMessage({
        //   to: phoneNumber,
        //   message: res.message || "HELLO WORLD",
        //   enableLinkPreview: false,
        // }).catch((err)=> {
        //   console.log(err.response);
        // });
      })
      .catch((err) => {
        console.error(err);
      });

    return {
      success: true,
      message: "Message processed successfully",
    };
  } catch (error) {
    console.error("Error processing WhatsApp webhook:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

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
                id: "wamid.HBgMOTE5MzI0NjEyMTYxFQIAEhggQUM0MTBEM0JFQ0ExRjk3REJCODNFQ0VBMjhEOTY4NkYA",
                timestamp: "1764237510",
                type: "audio",
                audio: {
                  mime_type: "audio/ogg; codecs=opus",
                  sha256: "j1L+RNrrAW9fR7TbMHiNHUw947Q4hn0IqDHZ+AhKmFo=",
                  id: "833441336196310",
                  voice: true,
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
