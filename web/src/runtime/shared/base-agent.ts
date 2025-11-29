/**
 * BaseAgent - Abstract base class for all AI agents
 * Eliminates repetitive LLM setup and provides common functionality
 */

import { callLLM, streamLLM, type createLLMClient } from "../shared/llm-client";
import type { AgentId } from "../../config";
import type { CoreMessage } from "ai";
import type { AgentAttachment, AgentInput } from "./multimodal";
import { normalizeAgentInput, summarizeInputForHistory } from "./multimodal";

export interface AgentOptions {
  agentId: AgentId;
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

export abstract class BaseAgent {
  protected readonly agentId: AgentId;
  protected readonly systemPrompt: string;
  protected readonly temperature: number;
  protected readonly maxTokens: number;

  constructor(options: AgentOptions) {
    this.agentId = options.agentId;
    this.systemPrompt = options.systemPrompt;
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens ?? 2048;
  }

  /**
   * Call LLM with agent's configuration
   */
  protected async callLLM(options: {
    messages: CoreMessage[];
    system?: string;
    tools?: Record<string, any>;
    maxSteps?: number;
    temperature?: number;
    maxTokens?: number;
  }) {
    return callLLM(this.agentId, {
      ...options,
      system: options.system ?? this.systemPrompt,
      temperature: options.temperature ?? this.temperature,
      maxTokens: options.maxTokens ?? this.maxTokens,
    });
  }

  /**
   * Stream LLM response with agent's configuration
   */
  protected async streamLLM(options: {
    messages: CoreMessage[];
    system?: string;
    tools?: Record<string, any>;
    maxSteps?: number;
    temperature?: number;
    maxTokens?: number;
  }) {
    return streamLLM(this.agentId, {
      ...options,
      system: options.system ?? this.systemPrompt,
      temperature: options.temperature ?? this.temperature,
      maxTokens: options.maxTokens ?? this.maxTokens,
    });
  }

  /**
   * Get agent metadata
   */
  getMetadata() {
    return {
      agentId: this.agentId,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
    };
  }
}

/**
 * BaseConversationalAgent - Abstract base for conversational agents
 * Consolidates common session management logic
 */

import { randomUUID } from "node:crypto";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  attachments?: AgentAttachment[];
}

export interface ConversationSession<TCollectedInfo = Record<string, unknown>> {
  sessionId: string;
  startedAt: string;
  messages: ConversationMessage[];
  state: "active" | "completed" | "abandoned";
  collectedInfo: TCollectedInfo;
}

export interface ConversationOptions {
  initialMessage?: string;
  maxTurns?: number;
}

export abstract class BaseConversationalAgent<
  TSession extends ConversationSession = ConversationSession,
> extends BaseAgent {
  protected activeSessions = new Map<string, TSession>();
  protected readonly maxSessionAge: number;

  constructor(options: AgentOptions & { maxSessionAgeMs?: number }) {
    super(options);
    this.maxSessionAge = options.maxSessionAgeMs ?? 3600_000; // 1 hour default
  }

  /**
   * Start a new conversation session
   */
  startConversation(options: ConversationOptions = {}): TSession {
    const sessionId = randomUUID();
    const session = this.createSession(sessionId, options);

    this.activeSessions.set(sessionId, session);

    if (options.initialMessage) {
      session.messages.push({
        role: "assistant",
        content: options.initialMessage,
        timestamp: new Date().toISOString(),
      });
    }

    return session;
  }

  /**
   * Get active conversation
   */
  getConversation(sessionId: string): TSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Hydrate conversation state from an external snapshot
   */
  hydrateSession(snapshot: TSession): void {
    try {
      this.activeSessions.set(snapshot.sessionId, cloneStructured(snapshot));
    } catch (e) {
      // No-op in stateless mode or if structuredClone isn't available
    }
  }

  /**
   * Snapshot the current state of a conversation for persistence
   */
  snapshotSession(sessionId: string): TSession | undefined {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    return cloneStructured(session);
  }

  /**
   * Release a conversation from in-memory tracking (after snapshot)
   */
  releaseSession(sessionId: string): void {
    try {
      this.activeSessions.delete(sessionId);
    } catch (e) {
      // no-op
    }
  }

  /**
   * End conversation
   */
  endConversation(sessionId: string, state: "completed" | "abandoned" = "abandoned"): void {
    try {
      const session = this.activeSessions.get(sessionId);
      if (session) {
        session.state = state;
      }
    } catch (e) {
      // no-op in stateless mode
    }
  }

  /**
   * Clean up old sessions
   */
  cleanupOldSessions(maxAgeMs?: number): void {
    const maxAge = maxAgeMs ?? this.maxSessionAge;
    const now = Date.now();

    for (const [sessionId, session] of this.activeSessions.entries()) {
      const age = now - Date.parse(session.startedAt);
      if (age > maxAge && session.state !== "active") {
        this.activeSessions.delete(sessionId);
      }
    }
  }

  /**
   * Abstract method to create a session - must be implemented by subclasses
   */
  protected abstract createSession(sessionId: string, options: ConversationOptions): TSession;

  /**
   * Abstract method to continue conversation - must be implemented by subclasses
   */
  abstract continueConversation(
    sessionId: string,
    userMessage: string | AgentInput,
    options?: ConversationOptions,
  ): Promise<any>;
}

export function prepareAgentInput(input: string | AgentInput | undefined): AgentInput {
  return normalizeAgentInput(input);
}

export function messageContentFromInput(input: AgentInput): { text: string; attachments?: AgentAttachment[] } {
  const payload: { text: string; attachments?: AgentAttachment[] } = {
    text: summarizeInputForHistory(input),
  };

  if (input.attachments && input.attachments.length > 0) {
    payload.attachments = input.attachments;
  }

  return payload;
}

function cloneStructured<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}
