import { EventEmitter } from "node:events";

import { logger } from "./logger.js";

export type AgentId = "mill" | "dev" | "param" | "chatur" | "sera";

export interface AgentMessage {
  id: string;
  from: AgentId;
  to: AgentId | "broadcast";
  type: "request" | "response" | "notification" | "question";
  payload: unknown;
  timestamp: string;
  conversationId?: string;
}

export interface MessageHandler {
  (message: AgentMessage): Promise<AgentMessage | null> | AgentMessage | null;
}

/**
 * In-memory message bus for inter-agent communication
 * Enables agents to "converse" and negotiate without external APIs
 */
export class AgentMessageBus extends EventEmitter {
  private messageLog: AgentMessage[] = [];
  private handlers = new Map<AgentId, Map<string, MessageHandler>>();
  private conversationContexts = new Map<string, AgentMessage[]>();

  constructor(logDir?: string) {
    super();
    // No longer using file logging - keeping logs in memory only
  }

  /**
   * Register a handler for a specific agent and message type
   */
  registerHandler(agentId: AgentId, messageType: string, handler: MessageHandler): void {
    if (!this.handlers.has(agentId)) {
      this.handlers.set(agentId, new Map());
    }
    this.handlers.get(agentId)!.set(messageType, handler);
  }

  /**
   * Send a message from one agent to another
   */
  async send(message: Omit<AgentMessage, "id" | "timestamp">): Promise<AgentMessage | null> {
    const fullMessage: AgentMessage = {
      ...message,
      id: this.generateMessageId(),
      timestamp: new Date().toISOString(),
    };

    this.messageLog.push(fullMessage);
    
    // Store in conversation context if part of a conversation
    if (fullMessage.conversationId) {
      if (!this.conversationContexts.has(fullMessage.conversationId)) {
        this.conversationContexts.set(fullMessage.conversationId, []);
      }
      this.conversationContexts.get(fullMessage.conversationId)!.push(fullMessage);
    }

    // Emit for listeners
    this.emit("message", fullMessage);
    this.emit(`message:${fullMessage.to}`, fullMessage);

    // Log to console instead of file
    logger.debug("message-bus", `Message ${fullMessage.id} from ${fullMessage.from} to ${fullMessage.to}`);

    // If targeted to specific agent, invoke handler
    if (fullMessage.to !== "broadcast") {
      const agentHandlers = this.handlers.get(fullMessage.to);
      if (agentHandlers) {
        const handler = agentHandlers.get(fullMessage.type);
        if (handler) {
          try {
            const response = await handler(fullMessage);
            if (response) {
              return this.send({
                from: fullMessage.to,
                to: fullMessage.from,
                type: "response",
                payload: response.payload,
                ...(fullMessage.conversationId ? { conversationId: fullMessage.conversationId } : {}),
              });
            }
          } catch (error) {
            logger.error("message-bus", `Handler failed for ${fullMessage.to}`, error);
          }
        }
      }
    }

    return fullMessage;
  }

  /**
   * Broadcast a message to all agents
   */
  async broadcast(
    from: AgentId,
    type: "request" | "response" | "notification" | "question",
    payload: unknown,
  ): Promise<void> {
    await this.send({ from, to: "broadcast", type, payload });
  }

  /**
   * Get conversation history for a specific conversation
   */
  getConversation(conversationId: string): AgentMessage[] {
    return this.conversationContexts.get(conversationId) ?? [];
  }

  /**
   * Get recent messages (for debugging/monitoring)
   */
  getRecentMessages(limit = 50): AgentMessage[] {
    return this.messageLog.slice(-limit);
  }

  /**
   * Clear conversation context (for memory management)
   */
  clearConversation(conversationId: string): void {
    this.conversationContexts.delete(conversationId);
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Singleton instance
let busInstance: AgentMessageBus | null = null;

export function getMessageBus(logDir?: string): AgentMessageBus {
  if (!busInstance) {
    busInstance = new AgentMessageBus(logDir);
  }
  return busInstance;
}
