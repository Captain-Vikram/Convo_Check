import { createServer } from "node:http";
import { URL } from "node:url";

import { createDevAgentEnvironment } from "../runtime/dev-agent.js";
import {
  processSmsMessage,
  type ProcessSmsMessageOutcome,
  type SmsExport,
  type SmsMessage,
} from "../runtime/dev-sms-agent.js";
import { createSmsLog } from "../runtime/sms-log.js";

const PORT = Number.parseInt(process.env.SMS_WEBHOOK_PORT ?? "7070", 10);

const environmentPromise = createDevAgentEnvironment();
const smsLogPromise = createSmsLog();

createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? "", `http://${req.headers.host ?? `localhost:${PORT}`}`);

    if (req.method !== "POST" || requestUrl.pathname !== "/sms") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    if (chunks.length === 0) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Empty request body" }));
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON", details: (error as Error).message }));
      return;
    }

    const messages = extractMessages(payload);

    if (messages.length === 0) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "No SMS messages found in payload" }));
      return;
    }

    const environment = await environmentPromise;
    const smsLog = await smsLogPromise;

    const results: Array<ProcessSmsMessageOutcome & { sender?: string }> = [];
    for (const message of messages) {
      try {
        const outcome = await processSmsMessage(message, {
          devEnvironment: environment,
          smsLog,
        });
        results.push({ ...outcome, sender: message.sender });
      } catch (error) {
        results.push({ status: "skipped", reason: "invalid" });
        console.error("[sms-webhook] Failed to process message", { message, error });
      }
    }

    const summary = {
      processed: results.filter((entry) => entry.status === "processed").length,
      duplicates: results.filter((entry) => entry.status === "duplicate").length,
      suppressed: results.filter((entry) => entry.status === "suppressed").length,
      skipped: results.filter((entry) => entry.status === "skipped").length,
    };

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        summary,
        results,
      }),
    );
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error", details: (error as Error).message }));
  }
}).listen(PORT, () => {
  console.log(`[sms-webhook] Listening on http://localhost:${PORT}/sms`);
});

function extractMessages(payload: unknown): SmsMessage[] {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload.filter(isSmsMessage);
  }

  if (isSmsMessage(payload)) {
    return [payload];
  }

  if (typeof payload === "object" && payload !== null) {
    const candidate = payload as Partial<SmsExport>;
    if (Array.isArray(candidate.messages)) {
      return candidate.messages.filter(isSmsMessage);
    }
  }

  return [];
}

function isSmsMessage(candidate: unknown): candidate is SmsMessage {
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }

  const sms = candidate as Record<string, unknown>;
  return typeof sms.sender === "string" && typeof sms.message === "string";
}
