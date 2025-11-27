// src/lib/wa/whatsAppMedia.ts
import axios from "axios";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const WHATSAPP_TOKEN = process.env.WA_TOKEN!;
const WHATSAPP_API_VERSION = "v21.0";
const WHATSAPP_BASE_URL = `https://graph.facebook.com/${WHATSAPP_API_VERSION}`;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME!;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL!; // e.g. https://media.yourdomain.com

export type MediaType = "image" | "audio" | "video" | "document" | "voice";

export interface WhatsAppMediaInput {
  id: string;            // WhatsApp media id
  mime_type?: string;    // optional
  sha256?: string;       // optional
  type?: MediaType;      // for folder structure / your own use
}

export interface WhatsAppR2MediaResult {
  id: string;
  mimeType: string;
  r2Key: string;   // path inside bucket
  url: string;     // public URL (R2_PUBLIC_BASE_URL + r2Key)
}

/**
 * 1. Fetch media from WhatsApp by id
 * 2. Upload to Cloudflare R2
 * 3. Return public URL
 */
export async function getPublicMediaUrlFromWhatsApp(
  media: WhatsAppMediaInput
): Promise<WhatsAppR2MediaResult> {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN not set");
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_BASE_URL) {
    throw new Error("R2 env variables are not fully set");
  }

  // --- R2 client ---
  const r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  try {
    // 1) Get media metadata (URL + mime_type) from WhatsApp
    const metaRes = await axios.get(`${WHATSAPP_BASE_URL}/${media.id}`, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      },
    });

    const fileUrl: string = metaRes.data.url;
    const mimeType: string = metaRes.data.mime_type;

    // 2) Download actual file bytes from WhatsApp media URL
    const fileRes = await axios.get<ArrayBuffer>(fileUrl, {
      responseType: "arraybuffer",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      },
    });

    const buffer = Buffer.from(fileRes.data);

    // 3) Decide R2 object key (folder based on type, fallback to "other")
    const extFromMime = mimeType.split("/")[1] || "bin"; // rough extension
    const folder = media.type ?? "other";
    const r2Key = `${folder}/${media.id}.${extFromMime}`;

    // 4) Upload to R2
    const putCommand = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: r2Key,
      Body: buffer,
      ContentType: mimeType,
      // ACL is ignored by R2; bucket/public access is controlled via R2 settings
    });

    await r2Client.send(putCommand);

    // 5) Build public URL
    const publicUrl = `${R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${r2Key}`;

    return {
      id: media.id,
      mimeType,
      r2Key,
      url: publicUrl,
    };
  } catch (err: any) {
    console.error("Error in getPublicMediaUrlFromWhatsApp:", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    throw err;
  }
}
