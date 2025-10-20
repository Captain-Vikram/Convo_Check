import { generateText } from "ai";
import { getAgentConfig, createLanguageModel } from "../../config.js";
import type { AgentId } from "./agent-message-bus.js";

export interface RoutingDecision {
  primaryAgent: AgentId;
  secondaryAgents: AgentId[];
  reasoning: string;
  requiresUserInput: boolean;
  suggestedWorkflow: string[];
}

export interface AgentCapability {
  agentId: AgentId;
  name: string;
  capabilities: string[];
  bestFor: string[];
}

const AGENT_CAPABILITIES: AgentCapability[] = [
  {
    agentId: "mill",
    name: "Mill (Chatbot)",
    capabilities: [
      "Log new transactions",
      "Query spending data",
      "Coordinate other agents",
      "Handle user conversations",
      "Manage duplicate transactions",
    ],
    bestFor: [
      "User requests to log expenses or income",
      "Questions about recent transactions",
      "General conversation about finances",
      "Duplicate resolution",
    ],
  },
  {
    agentId: "dev",
    name: "Dev (Transaction Agent)",
    capabilities: [
      "Parse SMS messages",
      "Extract transaction details",
      "Detect duplicates",
      "Normalize transaction data",
      "Monitor transaction database",
    ],
    bestFor: [
      "Processing SMS exports",
      "Detecting transaction anomalies",
      "Data validation and normalization",
      "Duplicate detection",
    ],
  },
  {
    agentId: "param",
    name: "Param (Analyst)",
    capabilities: [
      "Analyze spending patterns",
      "Generate financial insights",
      "Calculate metrics and trends",
      "Identify habits",
      "Provide evidence-based recommendations",
    ],
    bestFor: [
      "Spending analysis requests",
      "Pattern detection",
      "Budget analysis",
      "Financial trends",
      "Category breakdowns",
    ],
  },
  {
    agentId: "chatur",
    name: "Chatur (Coach)",
    capabilities: [
      "Provide personalized financial advice",
      "Create actionable guidance",
      "Tailor advice for gig workers",
      "Support Hindi/English",
      "Generate motivational tips",
    ],
    bestFor: [
      "Requests for financial advice",
      "Budget planning",
      "Savings goals",
      "Habit improvement suggestions",
      "Motivational support",
    ],
  },
];

const ROUTING_SYSTEM_PROMPT = `You are an intelligent agent router for a financial management system. Analyze user requests and decide which agent(s) should handle them.

Available agents and their capabilities:
${AGENT_CAPABILITIES.map(
  (a) =>
    `- ${a.name}: ${a.capabilities.join(", ")}. Best for: ${a.bestFor.join("; ")}.`,
).join("\n")}

Your task:
1. Understand the user's intent
2. Select the PRIMARY agent that should handle the request
3. List any SECONDARY agents that might be needed for a complete response
4. Explain your reasoning
5. Indicate if user input is required
6. Suggest a workflow (sequence of agent calls)

Respond ONLY with valid JSON in this format:
{
  "primaryAgent": "mill" | "dev" | "param" | "chatur",
  "secondaryAgents": ["agent1", "agent2"],
  "reasoning": "Brief explanation of why these agents",
  "requiresUserInput": true/false,
  "suggestedWorkflow": ["step1: agent does X", "step2: agent does Y"]
}`;

/**
 * Smart agent orchestrator that uses LLM to decide routing
 */
export class AgentOrchestrator {
  private routingCache = new Map<string, { decision: RoutingDecision; timestamp: number }>();
  private readonly cacheTtlMs = 60_000; // 60 seconds

  constructor(private readonly enableCache = true) {}

  /**
   * Route a user request to appropriate agent(s) using LLM reasoning
   */
  async route(userRequest: string, context?: string): Promise<RoutingDecision> {
    // Check cache
    const cacheKey = this.getCacheKey(userRequest, context);
    if (this.enableCache) {
      const cached = this.routingCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
        return cached.decision;
      }
    }

    try {
      const decision = await this.routeWithLlm(userRequest, context);
      
      // Cache the decision
      if (this.enableCache) {
        this.routingCache.set(cacheKey, { decision, timestamp: Date.now() });
      }

      return decision;
    } catch (error) {
      console.error("[orchestrator] LLM routing failed, using fallback", error);
      return this.fallbackRoute(userRequest);
    }
  }

  /**
   * Use LLM to make intelligent routing decisions
   */
  private async routeWithLlm(userRequest: string, context?: string): Promise<RoutingDecision> {
    const config = getAgentConfig("agent1"); // Use Mill's config
    const languageModel = createLanguageModel(config);

    const prompt = context
      ? `User request: "${userRequest}"\n\nContext: ${context}\n\nRoute this request.`
      : `User request: "${userRequest}"\n\nRoute this request.`;

    const result = await generateText({
      model: languageModel,
      messages: [
        { role: "system", content: ROUTING_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });

    const responseText = (result.text ?? "").trim();
    const decision = this.parseRoutingResponse(responseText);

    return decision;
  }

  /**
   * Fallback routing using simple keyword matching
   */
  private fallbackRoute(userRequest: string): RoutingDecision {
    const lower = userRequest.toLowerCase();

    // Pattern matching for common requests
    if (
      lower.includes("spent") ||
      lower.includes("spending") ||
      lower.includes("analyze") ||
      lower.includes("pattern") ||
      lower.includes("trend")
    ) {
      return {
        primaryAgent: "param",
        secondaryAgents: ["chatur"],
        reasoning: "Request involves spending analysis (fallback rule)",
        requiresUserInput: false,
        suggestedWorkflow: ["1: Param analyzes data", "2: Chatur provides advice"],
      };
    }

    if (
      lower.includes("advice") ||
      lower.includes("should i") ||
      lower.includes("tip") ||
      lower.includes("help me")
    ) {
      return {
        primaryAgent: "chatur",
        secondaryAgents: ["param"],
        reasoning: "Request for advice (fallback rule)",
        requiresUserInput: false,
        suggestedWorkflow: ["1: Param gets insights", "2: Chatur provides guidance"],
      };
    }

    if (lower.includes("log") || lower.includes("spent") || /\d+/.test(lower)) {
      return {
        primaryAgent: "mill",
        secondaryAgents: ["dev"],
        reasoning: "Request to log transaction (fallback rule)",
        requiresUserInput: false,
        suggestedWorkflow: ["1: Mill logs via Dev"],
      };
    }

    // Default to Mill for conversational handling
    return {
      primaryAgent: "mill",
      secondaryAgents: [],
      reasoning: "Default conversational routing (fallback)",
      requiresUserInput: false,
      suggestedWorkflow: ["1: Mill handles conversation"],
    };
  }

  /**
   * Parse LLM JSON response
   */
  private parseRoutingResponse(response: string): RoutingDecision {
    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const jsonText = jsonMatch ? jsonMatch[1]!.trim() : response;

      // Try to find JSON object
      const startIdx = jsonText.indexOf("{");
      const endIdx = jsonText.lastIndexOf("}");
      if (startIdx === -1 || endIdx === -1) {
        throw new Error("No JSON object found in response");
      }

      const parsed = JSON.parse(jsonText.slice(startIdx, endIdx + 1)) as RoutingDecision;

      // Validate required fields
      if (!parsed.primaryAgent || !Array.isArray(parsed.secondaryAgents)) {
        throw new Error("Invalid routing response structure");
      }

      return parsed;
    } catch (error) {
      console.error("[orchestrator] Failed to parse routing response:", response, error);
      throw error;
    }
  }

  private getCacheKey(request: string, context?: string): string {
    return `${request.toLowerCase().slice(0, 100)}|${context?.slice(0, 50) ?? ""}`;
  }

  /**
   * Clear routing cache
   */
  clearCache(): void {
    this.routingCache.clear();
  }
}
