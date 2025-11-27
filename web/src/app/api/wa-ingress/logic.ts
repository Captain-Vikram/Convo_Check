import processAgentMessage from "@/lib/mill/in-process-adapter";
import { prisma } from "@/lib/prisma";
import { WhatsAppWebhook } from "@/lib/wa/types";
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
    const text = body.entry[0].changes[0].value.messages[0].text?.body;

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

    processAgentMessage({
      userId: String(userId),
      message: text,
    })
      .then((res) => {
        console.log(res);
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
