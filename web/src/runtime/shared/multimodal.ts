import type { CoreMessage } from "ai";

export type AgentAttachmentType = "image" | "audio";

export interface AgentAttachment {
  type: AgentAttachmentType;
  mimeType: string;
  /**
   * Base64 payload or data URL. Preferred when no external URL is available.
   */
  data?: string;
  /**
   * Remote URL pointing to the asset. Used when data isn't provided.
   */
  url?: string;
  /**
   * Optional transcription for audio attachments to provide textual context.
   */
  transcription?: string;
  /** Friendly file name for logging/debugging */
  name?: string;
}

export interface AgentInput {
  text: string;
  attachments?: AgentAttachment[];
}

export function normalizeAgentInput(input: string | AgentInput | undefined): AgentInput {
  if (!input) {
    return { text: "" };
  }

  if (typeof input === "string") {
    return { text: input };
  }

  const text = typeof input.text === "string" ? input.text : "";
  const attachments = Array.isArray(input.attachments) ? input.attachments : undefined;
  if (attachments) {
    return { text, attachments };
  }

  return { text };
}

export function summarizeInputForHistory(input: AgentInput): string {
  const trimmed = input.text?.trim();
  const attachmentSummary = summarizeAttachments(input.attachments);

  if (trimmed && attachmentSummary) {
    return `${trimmed}\n${attachmentSummary}`;
  }

  if (trimmed) {
    return trimmed;
  }

  return attachmentSummary || "[No textual input]";
}

function summarizeAttachments(attachments?: AgentAttachment[]): string | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  const summaries = attachments.map((attachment, index) => {
    const label = attachment.name || `${attachment.type}-${index + 1}`;
    return `[${attachment.type.toUpperCase()} :: ${label} :: ${attachment.mimeType}]`;
  });

  return summaries.join("\n");
}

export function buildMultimodalContent(input: AgentInput): CoreMessage["content"] {
  const parts: Array<any> = [];
  const text = input.text?.trim();

  if (text) {
    parts.push({ type: "text", text });
  }

  input.attachments?.forEach((attachment) => {
    if (attachment.type === "image") {
      const imagePart = buildImagePart(attachment);
      if (imagePart) {
        parts.push(imagePart);
      }
      return;
    }

    if (attachment.type === "audio") {
      const audioPart = buildAudioPart(attachment);
      if (audioPart) {
        parts.push(audioPart);
      }

      if (attachment.transcription) {
        parts.push({
          type: "text",
          text: `Audio transcription (${attachment.mimeType}): ${attachment.transcription}`,
        });
      }
    }
  });

  if (parts.length === 0) {
    return text ?? "";
  }

  if (parts.length === 1 && parts[0].type === "text") {
    return parts[0].text;
  }

  return parts;
}

function buildImagePart(attachment: AgentAttachment): any | undefined {
  const base64 = extractBase64Payload(attachment.data);

  if (base64) {
    return {
      type: "image",
      imageBase64: base64,
      mimeType: attachment.mimeType,
    };
  }

  if (attachment.url) {
    return {
      type: "image",
      imageUrl: attachment.url,
    };
  }

  return undefined;
}

function buildAudioPart(attachment: AgentAttachment): any | undefined {
  const base64 = extractBase64Payload(attachment.data);
  if (!base64) {
    return undefined;
  }

  return {
    type: "input_audio",
    audio: {
      data: base64,
      format: inferAudioFormat(attachment.mimeType),
    },
  };
}

function extractBase64Payload(data?: string): string | undefined {
  if (!data) {
    return undefined;
  }

  if (data.startsWith("data:")) {
    const commaIndex = data.indexOf(",");
    if (commaIndex !== -1) {
      return data.slice(commaIndex + 1).trim();
    }
  }

  return data.trim();
}

function inferAudioFormat(mimeType?: string): string | undefined {
  if (!mimeType) {
    return undefined;
  }

  if (mimeType.includes("wav")) {
    return "wav";
  }
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) {
    return "mp3";
  }
  if (mimeType.includes("ogg")) {
    return "ogg";
  }
  if (mimeType.includes("webm")) {
    return "webm";
  }
  if (mimeType.includes("m4a")) {
    return "m4a";
  }

  return undefined;
}
