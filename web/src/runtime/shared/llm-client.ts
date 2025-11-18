/**
 * Shared LLM client utilities to eliminate repetitive LLM setup code.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, streamText, type CoreMessage, type LanguageModel } from "ai";
import { getAgentConfig, type AgentId } from "@/config";

/**
 * Create a configured LLM client for the given agent.
 * Eliminates repetitive getAgentConfig + createGoogleGenerativeAI pattern.
 */
export function createLLMClient(agentId: AgentId): LanguageModel {
  const { apiKey, model } = getAgentConfig(agentId);
  const provider = createGoogleGenerativeAI({ apiKey });
  return provider(model);
}

/**
 * Convenience wrapper for generateText with automatic agent config.
 */
export async function callLLM(
  agentId: AgentId,
  options: {
    messages: CoreMessage[];
    system?: string;
    tools?: Record<string, any>;
    maxSteps?: number;
    temperature?: number;
    maxTokens?: number;
  }
) {
  const model = createLLMClient(agentId);
  return generateText({
    model,
    ...options,
  });
}

/**
 * Convenience wrapper for streamText with automatic agent config.
 */
export function streamLLM(
  agentId: AgentId,
  options: {
    messages: CoreMessage[];
    system?: string;
    tools?: Record<string, any>;
    maxSteps?: number;
    temperature?: number;
    maxTokens?: number;
  }
) {
  const model = createLLMClient(agentId);
  return streamText({
    model,
    ...options,
  });
}
