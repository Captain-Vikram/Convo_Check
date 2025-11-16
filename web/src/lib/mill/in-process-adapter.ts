import {
  ConversationRouter,
  type ConversationRouterOptions,
  type ConversationContext,
  type ActiveAgent,
} from "../../../../src/runtime/shared/conversation-router";
import type { AgentAttachment, AgentInput } from "../../../../src/runtime/shared/multimodal";
import { getConversationStore } from "./conversation-store";

const conversationRouter = new ConversationRouter(getConversationStore());

export interface AgentEntryRequest {
  userId: string;
  message?: string;
  attachments?: AgentAttachment[];
  options?: ConversationRouterOptions;
}

export interface AgentEntryResponse {
  agent: ActiveAgent;
  message: string;
  completed: boolean;
  switched?: boolean;
  newAgent?: ActiveAgent;
  result?: unknown;
  sessionId?: string;
  context?: ConversationContext;
}

function resolveSessionId(context?: ConversationContext, agent?: ActiveAgent): string | undefined {
  if (!context) return undefined;
  switch (agent ?? context.activeAgent) {
    case "mill":
      return context.millSessionId;
    case "chatur":
      return context.chaturSessionId;
    case "sera":
      return context.seraSessionId;
    default:
      return context.millSessionId ?? context.chaturSessionId ?? context.seraSessionId;
  }
}

export async function processAgentMessage(
  req: AgentEntryRequest,
): Promise<AgentEntryResponse> {
  if (!req?.userId?.trim()) {
    throw new Error("userId is required");
  }
  const hasMessage = Boolean(req?.message?.trim());
  const hasAttachments = Array.isArray(req.attachments) && req.attachments.length > 0;

  if (!hasMessage && !hasAttachments) {
    throw new Error("Either message or attachments are required");
  }

  const agentInput: AgentInput = {
    text: req.message ?? "",
    attachments: hasAttachments ? req.attachments : undefined,
  };

  const response = await conversationRouter.continueConversation(
    req.userId,
    agentInput,
    req.options,
  );

  const context = await conversationRouter.getContext(req.userId);
  const sessionId =
    (response as { sessionId?: string }).sessionId ?? resolveSessionId(context, response.agent);

  return {
    ...response,
    sessionId,
    context,
  };
}

export default processAgentMessage;
