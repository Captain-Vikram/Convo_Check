import { processWhatsAppWebhook } from "./logic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    const result = await processWhatsAppWebhook(body);
    
    return Response.json(result);
  } catch (error) {
    console.error("Error processing WhatsApp webhook:", error);
    return Response.json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
}

export async function GET() {
  return Response.json({ message: "WhatsApp ingress endpoint" });
}