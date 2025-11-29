import processAgentMessage from "@/lib/mill/in-process-adapter";
import { prisma } from "@/lib/prisma";
import { WhatsAppWebhook } from "@/lib/wa/types";
import { getPublicMediaUrlFromWhatsApp } from "@/lib/wa/whatsAppMedia";
import { AgentAttachment, AgentAttachmentType } from "@/runtime/shared/multimodal";
import { randomUUID } from "crypto";
import { wacloud } from "@/lib/wacloud";
import { processMultimodalContent } from "./multimodal";

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

    // Array to hold all attachments
    const attachments: AgentAttachment[] = [];

    if (
      body.entry[0].changes[0].value.messages[0].type == "image" &&
      body.entry[0].changes[0].value.messages[0].image
    ) {
      const imageResult = await getPublicMediaUrlFromWhatsApp({
        id: body.entry[0].changes[0].value.messages[0].image?.id,
        mime_type: body.entry[0].changes[0].value.messages[0].image.mime_type,
        sha256: body.entry[0].changes[0].value.messages[0].image.sha256,
        type: "image",
      });
      if (imageResult) {
        attachments.push({
          type: "image" as AgentAttachmentType,
          mimeType: imageResult.mimeType,
          url: imageResult.url,
          name: "Image",
        });
        // Use caption if available, otherwise use original text
        text = body.entry[0].changes[0].value.messages[0].image.caption || text || "I sent an image";
      }
    }

    if (
      body.entry[0].changes[0].value.messages[0].type == "audio" &&
      body.entry[0].changes[0].value.messages[0].audio
    ) {
      const audioResult = await getPublicMediaUrlFromWhatsApp({
        id: body.entry[0].changes[0].value.messages[0].audio?.id,
        mime_type: body.entry[0].changes[0].value.messages[0].audio.mime_type,
        sha256: body.entry[0].changes[0].value.messages[0].audio.sha256,
        type: "audio",
      });
      if (audioResult) {
        attachments.push({
          type: "audio" as AgentAttachmentType,
          mimeType: audioResult.mimeType,
          url: audioResult.url,
          name: "Audio recording",
        });
        // Set placeholder text that will be replaced with transcription
        text = "I have attached an audio recording";
      }
    }



    console.log({
      phoneNumber: phoneNumber,
      wamid: wamid,
      text: text,
      attachments: attachments,
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

    // PROCESS MULTIMODAL CONTENT IF THERE ARE ATTACHMENTS
    let processedText = text;
    if (attachments.length > 0) {
      try {
        processedText = await processMultimodalContent(text || "", attachments as { type: AgentAttachmentType; url: string; mimeType: string; name?: string }[]);
      } catch (error) {
        console.error("Error processing multimodal content:", error);
        processedText = text; // Fallback to original text
      }
    }

    // STORE THE MESSAGE IN DB

    const message = await prisma.wa_messages.create({
      data: {
        id: randomUUID(),
        date_created: new Date(),
        date_updated: new Date(),
        text: processedText, // Use the processed text with transcriptions
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
      message: processedText,
      attachments: attachments,
    });

    // PROCESS THE MESSAGE WITH AGENT
    processAgentMessage({
      userId: String(userId),
      message: processedText,
      attachments: attachments, // Attachments now include transcriptions
    })
      .then(async (res) => {
        try {
          const waresponse = await wacloud.sendMessage({
            to: phoneNumber,
            message: res.message || "HELLO WORLD",
            enableLinkPreview: false,
          });

          await prisma.wa_messages.create({
            data: {
              id: randomUUID(),
              date_created: new Date(),
              wamid: waresponse.wamid,
              direction: "out",
              users: {
                connect: {
                  id: userId,
                },
              },
            },
          });
        } catch (err2) {
          console.error(err2);
        }
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
