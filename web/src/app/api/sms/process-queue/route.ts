import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import {
  processQueuedSmsMessage,
  resolveEnvironment,
  resolveSmsLog,
} from "@/lib/sms-processor";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Cron job handler to process queued SMS messages.
 * This endpoint should be called by a cron service (e.g., Vercel Cron Jobs) every minute.
 */
export async function GET(request: Request) {
  // Security check
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get("secret");

  if (secret !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch queued jobs from database
  const queuedMessages = await prisma.sms_messages.findMany({
    where: {
      status: "queued",
    },
    take: 10, // Process 10 messages per minute to avoid serverless timeouts
    orderBy: {
      date_created: "asc", // Process oldest first
    },
    select: {
      id: true,
      owner: true,
      raw_text: true,
      sender_name: true,
      time: true,
      date_created: true,
      receiver_phone_number: true,
    },
  });

  if (queuedMessages.length === 0) {
    return NextResponse.json({
      message: "No queued messages found.",
      processedCount: 0,
    });
  }

  console.log(`[process-queue] Processing ${queuedMessages.length} queued messages`);

  // Setup shared environment
  let environment;
  let smsLog;
  try {
    environment = await resolveEnvironment();
    smsLog = await resolveSmsLog();
  } catch (error: unknown) {
    console.error("[process-queue] Failed to initialize environment", error);
    return NextResponse.json(
      {
        error: "Environment initialization failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }

  let processedCount = 0;
  let errorCount = 0;
  const processingResults: Array<{ smsId: number; status: string; error?: string }> = [];

  // Process each queued message
  for (const sms of queuedMessages) {
    if (!sms.owner || !sms.raw_text) {
      console.warn("[process-queue] Skipping invalid SMS", { id: sms.id });
      continue;
    }

    try {
      const timestamp = sms.time ?? sms.date_created ?? new Date();
      const timestampIso = timestamp.toISOString();

      const job = {
        smsMessageId: sms.id,
        userId: sms.owner,
        sender: sms.sender_name ?? "Unknown Sender",
        senderName: sms.sender_name ?? "Unknown Sender",
        message: sms.raw_text,
        timestampIso,
        datePart: timestampIso.slice(0, 10),
        timePart: timestampIso.slice(11, 19),
      };

      const outcome = await processQueuedSmsMessage(job, environment, smsLog);

      processingResults.push({
        smsId: sms.id,
        status: outcome.status,
      });
      processedCount++;
    } catch (error: unknown) {
      errorCount++;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      processingResults.push({
        smsId: sms.id,
        status: "error",
        error: errorMessage,
      });

      // Mark job as error in DB
      try {
        await prisma.sms_messages.update({
          where: { id: sms.id },
          data: {
            status: "error",
            processing_notes: `Failed in cron job: ${errorMessage}`,
            processed_at: new Date(),
          },
        });
      } catch (dbError) {
        console.error(`[process-queue] Failed to mark job ${sms.id} as error:`, dbError);
      }
    }
  }

  console.log(`[process-queue] Completed: ${processedCount} processed, ${errorCount} errors`);

  return NextResponse.json({
    message: `Processed ${processedCount} messages, ${errorCount} errors.`,
    processedCount,
    errorCount,
    results: processingResults,
  });
}
