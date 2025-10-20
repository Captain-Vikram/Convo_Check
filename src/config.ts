import { config as loadEnv } from "dotenv";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

loadEnv();

// Simple provider and model configuration
const DEFAULT_PROVIDER = process.env.AI_PROVIDER?.toLowerCase() === "google" ? "google" : "bedrock";

// Bedrock model defaults (optimized for each agent role)
const BEDROCK_MODELS = {
  chatbot: "anthropic.claude-3-5-sonnet-20241022-v2:0",    // Best for conversation + tools
  accountant: "anthropic.claude-3-5-haiku-20241022-v1:0",  // Fast for transaction parsing
  analyst: "anthropic.claude-3-5-sonnet-20241022-v2:0",    // Best for analysis + JSON
  coach: "anthropic.claude-3-5-sonnet-20241022-v2:0",      // Best for advice + reasoning
};

// Google model defaults
const GOOGLE_MODELS = {
  chatbot: "gemini-2.0-flash-exp",
  accountant: "gemini-2.0-flash-exp",
  analyst: "gemini-2.0-flash-exp",
  coach: "gemini-2.0-flash-exp",
};

const DEFAULT_AWS_REGION = process.env.AWS_REGION || "us-east-1";

export type AgentId = "agent1" | "agent2" | "agent3" | "agent4";
export type AgentRole = "chatbot" | "accountant" | "analyst" | "coach";

interface AgentSetting {
  id: AgentId;
  role: AgentRole;
  title: string;
  codename: string;
  apiKeyEnv: string;
  modelEnv: string;
  awsRegionEnv?: string;
}

const AGENT_SETTINGS = [
  {
    id: "agent1",
    role: "chatbot",
    title: "Chatbot",
    codename: "Mill",
    apiKeyEnv: "GOOGLE_API_KEY",  // Only used when AI_PROVIDER=google
    modelEnv: "CHATBOT_MODEL",
    awsRegionEnv: "AWS_REGION",
  },
  {
    id: "agent2",
    role: "accountant",
    title: "Accountant",
    codename: "Dev",
    apiKeyEnv: "GOOGLE_API_KEY",
    modelEnv: "ACCOUNTANT_MODEL",
    awsRegionEnv: "AWS_REGION",
  },
  {
    id: "agent3",
    role: "analyst",
    title: "Param",
    codename: "Param",
    apiKeyEnv: "GOOGLE_API_KEY",
    modelEnv: "ANALYST_MODEL",
    awsRegionEnv: "AWS_REGION",
  },
  {
    id: "agent4",
    role: "coach",
    title: "Coach",
    codename: "Coach",
    apiKeyEnv: "GOOGLE_API_KEY",
    modelEnv: "COACH_MODEL",
    awsRegionEnv: "AWS_REGION",
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
  provider: "bedrock" | "google";
  awsRegion?: string | undefined;
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
  const provider = getProvider();

  // For Bedrock, we don't need API keys (uses AWS credentials)
  // For Google, we need a single GOOGLE_API_KEY
  const apiKey = provider === "google" ? requireEnv(setting.apiKeyEnv) : "";
  const model = resolveModel(setting);
  const awsRegion = provider === "bedrock" ? (setting.awsRegionEnv ? process.env[setting.awsRegionEnv] : undefined) : undefined;

  return {
    id: setting.id,
    role: setting.role,
    title: setting.title,
    codename: setting.codename,
    apiKey,
    model,
    provider,
    awsRegion,
  };
}

export function getGeminiDefaultModel(): string {
  return process.env.AI_MODEL || GOOGLE_MODELS.chatbot;
}

export function getProvider(): "bedrock" | "google" {
  return DEFAULT_PROVIDER;
}

function requireEnv(key: string): string {
  const value = process.env[key];

  if (!value) {
    throw new Error(`Environment variable ${key} is not defined.`);
  }

  return value;
}

function resolveModel(setting: AgentSettingEntry): string {
  // 1. Check agent-specific env var (e.g., CHATBOT_MODEL)
  if (process.env[setting.modelEnv]) {
    return process.env[setting.modelEnv]!;
  }
  
  // 2. Check global AI_MODEL env var
  if (process.env.AI_MODEL) {
    return process.env.AI_MODEL;
  }
  
  // 3. Use provider-specific defaults based on role
  if (DEFAULT_PROVIDER === "bedrock") {
    return BEDROCK_MODELS[setting.role];
  } else {
    return GOOGLE_MODELS[setting.role];
  }
}

function findAgentSetting(agentId: AgentId): AgentSettingEntry {
  const setting = AGENT_SETTINGS.find((agent) => agent.id === agentId);

  if (!setting) {
    throw new Error(`Unknown agent id: ${agentId}`);
  }

  return setting;
}

/**
 * Helper to create language model instance with proper type casting
 * Both Bedrock and Google providers return compatible models at runtime
 */
export function createLanguageModel(config: AgentRuntimeConfig) {
  const { provider, apiKey, model, awsRegion } = config;
  
  if (provider === "bedrock") {
    return createAmazonBedrock({ 
      region: awsRegion || DEFAULT_AWS_REGION
    })(model) as any;
  } else {
    return createGoogleGenerativeAI({ apiKey })(model) as any;
  }
}
