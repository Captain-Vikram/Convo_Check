import processAgentMessage, {
  type AgentEntryRequest,
} from "../../../lib/mill/in-process-adapter";

export interface ProcessAgentMessageResult {
  success: boolean;
  data?: any;
  error?: string;
}

export async function processAgentMessageRequest(
  body: Partial<AgentEntryRequest>
): Promise<ProcessAgentMessageResult> {
  try {
    const userId = body.userId?.trim();
    const message = body.message ?? "";
    const attachments = Array.isArray(body.attachments) && body.attachments.length > 0
      ? body.attachments
      : undefined;

    if (!userId) {
      return {
        success: false,
        error: "userId is required",
      };
    }

    if (!message.trim() && !attachments) {
      return {
        success: false,
        error: "Provide a message or at least one attachment",
      };
    }

    const result = await processAgentMessage({
      userId,
      message,
      attachments,
      options: body.options,
    });

    return {
      success: true,
      data: result,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMessage,
    };
  }
}