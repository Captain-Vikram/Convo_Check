import type { AgentId } from "../config.js";

export interface ToolParameter {
  name: string;
  description: string;
  type: "string" | "number" | "boolean" | "enum" | "object";
  required: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
}

export interface AgentDefinition {
  id: AgentId;
  role: string;
  title: string;
  codename: string;
  systemPrompt: string;
  tools: ToolDefinition[];
}
