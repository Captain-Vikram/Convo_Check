import {
  conversationRouter,
  type ConversationRouterOptions,
  type ConversationContext,
  type ActiveAgent,
} from "../../../../src/runtime/shared/conversation-router";

export interface AgentEntryRequest {
  userId: string;
  message: string;
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
  if (!req?.message?.trim()) {
    throw new Error("message is required");
  }

  const response = await conversationRouter.continueConversation(
    req.userId,
    req.message,
    req.options,
  );

  const context = conversationRouter.getContext(req.userId);
  const sessionId =
    (response as { sessionId?: string }).sessionId ?? resolveSessionId(context, response.agent);

  return {
    ...response,
    sessionId,
    context,
  };
}

export default processAgentMessage;
