import type { AgentId } from "../config.js";
import { chatbotAgent } from "./chatbot.js";
import { analystAgent } from "./analyst.js";
import { coachAgent } from "./coach.js";
import { devAgent } from "./dev.js";
import type { AgentDefinition } from "./types.js";

const agentRegistry: Record<AgentId, AgentDefinition | undefined> = {
  agent1: chatbotAgent,
  agent2: devAgent,
  agent3: analystAgent,
  agent4: coachAgent,
};

export function getAgentDefinition(agentId: AgentId): AgentDefinition {
  const agent = agentRegistry[agentId];

  if (!agent) {
    throw new Error(`Agent definition for ${agentId} has not been implemented yet.`);
  }

  return agent;
}

export function listAgentDefinitions(): AgentDefinition[] {
  return Object.values(agentRegistry).filter((entry): entry is AgentDefinition => Boolean(entry));
}
