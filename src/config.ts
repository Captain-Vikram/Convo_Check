import { config as loadEnv } from "dotenv";

loadEnv();

const DEFAULT_MODEL_FALLBACK = "gemini-2.0-pro-exp";
const DEFAULT_MODEL_ENV = "GEMINI_DEFAULT_MODEL";

export type AgentId = "agent1" | "agent2" | "agent3" | "agent4";
export type AgentRole = "chatbot" | "accountant" | "analyst" | "coach";

interface AgentSetting {
  id: AgentId;
  role: AgentRole;
  title: string;
  codename: string;
  apiKeyEnv: string;
  modelEnv: string;
}

const AGENT_SETTINGS = [
  {
    id: "agent1",
    role: "chatbot",
    title: "Chatbot",
    codename: "Mill",
    apiKeyEnv: "CHATBOT_GEMINI_API_KEY",
    modelEnv: "CHATBOT_GEMINI_MODEL",
  },
  {
    id: "agent2",
    role: "accountant",
    title: "Accountant",
    codename: "Dev",
    apiKeyEnv: "ACCOUNTANT_GEMINI_API_KEY",
    modelEnv: "ACCOUNTANT_GEMINI_MODEL",
  },
  {
    id: "agent3",
    role: "analyst",
    title: "Param",
    codename: "Param",
    apiKeyEnv: "ANALYST_GEMINI_API_KEY",
    modelEnv: "ANALYST_GEMINI_MODEL",
  },
  {
    id: "agent4",
    role: "coach",
    title: "Coach",
    codename: "Coach",
    apiKeyEnv: "COACH_GEMINI_API_KEY",
    modelEnv: "COACH_GEMINI_MODEL",
  },
] as const satisfies readonly AgentSetting[];

type AgentSettingEntry = (typeof AGENT_SETTINGS)[number];

export interface AgentDescriptor {
  id: AgentId;
  role: AgentRole;
  title: string;
  codename: string;
}

export interface AgentRuntimeConfig extends AgentDescriptor {
  apiKey: string;
  model: string;
}

export function listAgentDescriptors(): AgentDescriptor[] {
  return AGENT_SETTINGS.map(({ id, role, title, codename }) => ({ id, role, title, codename }));
}

export function getAgentDescriptor(agentId: AgentId): AgentDescriptor {
  const setting = findAgentSetting(agentId);
  return { id: setting.id, role: setting.role, title: setting.title, codename: setting.codename };
}

export function assertRequiredEnvVars(): void {
  const missing: string[] = [];

  for (const { apiKeyEnv } of AGENT_SETTINGS) {
    if (!process.env[apiKeyEnv]) {
      missing.push(apiKeyEnv);
    }
  }

  if (missing.length > 0) {
    const message = `Missing required environment variables: ${missing.join(", ")}`;
    throw new Error(message);
  }
}

export function getAgentConfig(agentId: AgentId): AgentRuntimeConfig {
  const setting = findAgentSetting(agentId);

  const apiKey = requireEnv(setting.apiKeyEnv);
  const model = resolveModel(setting);

  return {
    id: setting.id,
    role: setting.role,
    title: setting.title,
    codename: setting.codename,
    apiKey,
    model,
  };
}

export function getGeminiDefaultModel(): string {
  return process.env[DEFAULT_MODEL_ENV] ?? DEFAULT_MODEL_FALLBACK;
}

function requireEnv(key: string): string {
  const value = process.env[key];

  if (!value) {
    throw new Error(`Environment variable ${key} is not defined.`);
  }

  return value;
}

function resolveModel(setting: AgentSettingEntry): string {
  return process.env[setting.modelEnv] ?? process.env[DEFAULT_MODEL_ENV] ?? DEFAULT_MODEL_FALLBACK;
}

function findAgentSetting(agentId: AgentId): AgentSettingEntry {
  const setting = AGENT_SETTINGS.find((agent) => agent.id === agentId);

  if (!setting) {
    throw new Error(`Unknown agent id: ${agentId}`);
  }

  return setting;
}
