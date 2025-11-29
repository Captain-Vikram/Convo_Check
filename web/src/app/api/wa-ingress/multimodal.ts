import OpenAI from "openai";
import { Readable } from "stream";
import axios from "axios";
import { AgentAttachment, AgentAttachmentType } from "@/runtime/shared/multimodal";

async function transcribeFromUrl(openai: OpenAI, url: string) {
  const res = await axios.get(url, { responseType: "arraybuffer" });

  const buffer = Buffer.from(res.data);

  const stream = Readable.from(buffer);

  const transcription = await openai.audio.transcriptions.create({
    file: stream,
    model: "whisper-1", // Using whisper instead of gpt-4o-transcribe which doesn't exist
  });

  return transcription.text;
}

export async function processAudioAttachment(audioUrl: string, mimeType: string): Promise<string> {
  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const transcription = await transcribeFromUrl(openai, audioUrl);
    
    return transcription;
  } catch (error) {
    console.error("Error transcribing audio:", error);
    throw error;
  }
}

export async function processImageAttachment(imageUrl: string, mimeType: string): Promise<string> {
  // For now, just return a placeholder for image processing
  // In the future, we could use vision models to analyze images
  return "User sent an image";
}

export async function processMultimodalContent(
  text: string,
  attachments: { type: AgentAttachmentType; url: string; mimeType: string; name?: string }[]
): Promise<string> {
  let content = text || "";

  for (const attachment of attachments) {
    if (attachment.type === "audio" && attachment.url) {
      try {
        const transcription = await processAudioAttachment(attachment.url, attachment.mimeType);
        content += `\nAudio transcription: ${transcription}`;
      } catch (error) {
        console.error("Error processing audio attachment:", error);
        content += "\nAudio attachment: [transcription failed]";
      }
    } else if (attachment.type === "image" && attachment.url) {
      try {
        const imageDescription = await processImageAttachment(attachment.url, attachment.mimeType);
        content += `\nImage: ${imageDescription}`;
      } catch (error) {
        console.error("Error processing image attachment:", error);
        content += "\nImage: [could not process]";
      }
    }
  }

  return content.trim();
}

// Enhanced function that also updates the attachments with transcriptions
export async function processAttachmentsWithTranscription(inputAttachments: AgentAttachment[]): Promise<AgentAttachment[]> {
  const processedAttachments: AgentAttachment[] = [];

  for (const attachment of inputAttachments) {
    if (attachment.type === "audio" && attachment.url) {
      try {
        const openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY,
        });

        const transcription = await transcribeFromUrl(openai, attachment.url);
        
        // Add the transcription to the attachment
        processedAttachments.push({
          ...attachment,
          transcription: transcription
        });
      } catch (error) {
        console.error("Error processing audio attachment:", error);
        // Add the attachment without transcription if processing fails
        processedAttachments.push(attachment);
      }
    } else {
      // For non-audio attachments, just pass them through
      processedAttachments.push(attachment);
    }
  }

  return processedAttachments;
}