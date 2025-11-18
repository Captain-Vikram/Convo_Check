import type { AgentId } from "../config";
import { chatbotAgent } from "./chatbot";
import { analystAgent } from "./analyst";
import { coachAgent } from "./coach";
import { devAgent } from "./dev";
import { seraAgent } from "./sera";
import type { AgentDefinition } from "./types";

const agentRegistry: Record<AgentId, AgentDefinition | undefined> = {
  agent1: chatbotAgent,
  agent2: devAgent,
  agent3: analystAgent,
  agent4: coachAgent,
  agent5: seraAgent,
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
