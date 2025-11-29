import type { CoreMessage } from "ai";

// Minimal, compatible multimodal helper
// This file intentionally keeps the exported types and helpers but
// simplifies behavior: attachments with an accessible `url` become
// content parts that hold a `URL` object (matching the user's snippet).

export type AgentAttachmentType = "image" | "audio";

export interface AgentAttachment {
  type: AgentAttachmentType;
  mimeType?: string;
  data?: string; // optional base64/data URL (not used by the minimal flow)
  url?: string; // remote URL to the asset
  transcription?: string;
  name?: string;
}

export interface AgentInput {
  text: string;
  attachments?: AgentAttachment[];
}

export function normalizeAgentInput(input: string | AgentInput | undefined): AgentInput {
  if (!input) return { text: "" };
  if (typeof input === "string") return { text: input };
  return { text: input.text ?? "", attachments: Array.isArray(input.attachments) ? input.attachments : undefined };
}

export function summarizeInputForHistory(input: AgentInput): string {
  const t = input.text?.trim() ?? "";
  if (!t && (!input.attachments || input.attachments.length === 0)) return "[No textual input]";
  return t || `[${(input.attachments || []).map((a) => a.type).join(",")}]`;
}

export function buildMultimodalContent(input: AgentInput): CoreMessage["content"] {
  // Build minimal content array that mirrors the snippet the user provided.
  const parts: any[] = [];
  const text = input.text?.trim();
  if (text) parts.push({ type: "text", text });

  input.attachments?.forEach((att) => {
    if (att.type === "image") {
      if (att.url) {
        try {
          parts.push({ type: "image", image: new URL(att.url) });
        } catch {
          // If URL creation fails, fallback to using the raw URL string
          parts.push({ type: "image", image: att.url });
        }
      } else if (att.data) {
        parts.push({ type: "image", image: att.data });
      }
    }

    if (att.type === "audio") {
      // For audio, if we have a transcription, prioritize that
      if (att.transcription) {
        // Add the transcription as text content
        parts.push({ type: "text", text: `Audio transcription: ${att.transcription}` });
      } else if (att.url) {
        // If no transcription exists, try to use the file for models that support direct audio
        try {
          const urlObj = new URL(att.url);
          parts.push({ type: "file", data: urlObj, mimeType: att.mimeType || "audio/mpeg" });
        } catch {
          // If URL creation fails, include as text indicating the file
          parts.push({ type: "text", text: `Audio file: ${att.url}` });
        }
      }
    }
  });

  if (parts.length === 0) return text ?? "";
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

// Keep a minimal async alias for previous google-specific builder so callers
// that import it still work. This implementation is intentionally simple and
// does not attempt to fetch remote files — it returns the same lightweight
// content that `buildMultimodalContent` returns.
export async function buildGoogleMultimodalContent(input: AgentInput): Promise<CoreMessage["content"]> {
  return buildMultimodalContent(input);
}
