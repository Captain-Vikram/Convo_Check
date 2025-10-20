/**
 * Smart Query Router for Mill Agent
 * 
 * Analyzes user queries to determine:
 * 1. Which agent should handle it (Mill for data, Chatur for coaching)
 * 2. What type of data is needed (transactions vs habits/analysis)
 * 3. Route appropriately without unnecessary agent handoffs
 */

import { generateText } from "ai";
import { getAgentConfig, createLanguageModel } from "../../config.js";

export interface QueryRouting {
  targetAgent: "mill" | "chatur";
  confidence: "high" | "medium" | "low";
  reasoning: string;
  dataNeeded: {
    type: "raw_transactions" | "habit_analysis" | "spending_patterns" | "coaching_advice" | "mixed";
    scope: "yesterday" | "last_n_days" | "last_month" | "current_month" | "specific_period" | "all";
    filters?: {
      transactionType?: "debit" | "credit" | "all";
      category?: string;
      merchant?: string;
      amountRange?: { min?: number; max?: number };
    };
  };
  shouldEscalate: boolean;
  escalationReason?: string;
}

/**
 * Analyze query and determine routing
 */
export async function routeQuery(userQuery: string): Promise<QueryRouting> {
  const systemPrompt = `You are a smart query router for a financial assistance system with two agents:

**MILL (Chatbot/Data Agent):**
- Retrieves raw transaction data
- Shows lists of transactions
- Provides factual information (amounts, dates, merchants)
- Answers "WHAT" questions: "What did I spend?", "Show my transactions"
- Direct data queries without interpretation

**CHATUR (Coach Agent):**
- Provides financial advice and coaching
- Analyzes spending habits and patterns
- Gives recommendations and suggestions
- Answers "WHY/HOW/SHOULD" questions: "Why am I overspending?", "How can I save?", "Should I cut this expense?"
- Behavioral insights and guidance

**QUERY CLASSIFICATION PATTERNS:**

Mill (Data Retrieval):
- "Show me my transactions yesterday"
- "What did I spend last month?"
- "List all payments to [merchant]"
- "How much did I pay [merchant]?"
- "What were my expenses this week?"
- "Display my income for October"

Chatur (Coaching/Analysis):
- "Why am I spending so much?"
- "How can I reduce my expenses?"
- "Am I overspending on food?"
- "Should I stop paying [merchant]?"
- "Give me advice on my spending"
- "What's my spending habit like?"
- "Help me budget better"

Mixed (Start with Mill, escalate to Chatur):
- "Show my transactions and tell me if I'm overspending"
- "What did I spend on food and is it too much?"

**DATA TYPE NEEDED:**

raw_transactions:
- User wants to see actual transaction list
- Factual data queries
- Historical records

habit_analysis:
- User wants to understand patterns
- Behavioral insights
- Trend analysis

spending_patterns:
- User wants to see categories/summaries
- Aggregate views
- Pattern recognition

coaching_advice:
- User wants recommendations
- Action items
- Financial guidance

**RESPONSE FORMAT (JSON):**
{
  "targetAgent": "mill|chatur",
  "confidence": "high|medium|low",
  "reasoning": "Brief explanation of why this agent should handle it",
  "dataNeeded": {
    "type": "raw_transactions|habit_analysis|spending_patterns|coaching_advice|mixed",
    "scope": "yesterday|last_n_days|last_month|current_month|specific_period|all",
    "filters": {
      "transactionType": "debit|credit|all",
      "category": "category name",
      "merchant": "merchant name",
      "amountRange": { "min": 0, "max": 1000 }
    }
  },
  "shouldEscalate": true|false,
  "escalationReason": "Reason to escalate to Chatur after Mill provides data"
}

RESPOND ONLY WITH VALID JSON.`;

  try {
    const config = getAgentConfig("agent1");
    const languageModel = createLanguageModel(config);

    const result = await generateText({
      model: languageModel,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Analyze and route this query: "${userQuery}"\n\nCurrent date: ${new Date().toISOString().split("T")[0]}`,
        },
      ],
    });

    const text = result.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        targetAgent: parsed.targetAgent || "mill",
        confidence: parsed.confidence || "medium",
        reasoning: parsed.reasoning || "Query analysis completed",
        dataNeeded: {
          type: parsed.dataNeeded?.type || "raw_transactions",
          scope: parsed.dataNeeded?.scope || "all",
          filters: parsed.dataNeeded?.filters || {},
        },
        shouldEscalate: parsed.shouldEscalate || false,
        escalationReason: parsed.escalationReason,
      };
    }

    // Fallback
    return createFallbackRouting(userQuery);
  } catch (error) {
    console.error("[mill-router] Failed to route query with LLM", error);
    return createFallbackRouting(userQuery);
  }
}

/**
 * Create fallback routing when LLM fails
 */
function createFallbackRouting(query: string): QueryRouting {
  const lowerQuery = query.toLowerCase();

  // Coaching keywords
  const coachingKeywords = [
    "why",
    "how can i",
    "should i",
    "advice",
    "help",
    "reduce",
    "save",
    "budget",
    "overspending",
    "too much",
    "habit",
    "pattern",
    "recommend",
    "suggestion",
  ];

  // Data retrieval keywords
  const dataKeywords = [
    "show",
    "list",
    "what",
    "display",
    "transactions",
    "spent",
    "paid",
    "income",
    "expenses",
  ];

  const hasCoachingKeyword = coachingKeywords.some((kw) => lowerQuery.includes(kw));
  const hasDataKeyword = dataKeywords.some((kw) => lowerQuery.includes(kw));

  // Determine routing
  if (hasCoachingKeyword && !hasDataKeyword) {
    return {
      targetAgent: "chatur",
      confidence: "medium",
      reasoning: "Query contains coaching keywords and requests advice",
      dataNeeded: {
        type: "coaching_advice",
        scope: "all",
      },
      shouldEscalate: false,
    };
  }

  if (hasCoachingKeyword && hasDataKeyword) {
    return {
      targetAgent: "mill",
      confidence: "medium",
      reasoning: "Query requests both data and advice - start with Mill, escalate to Chatur",
      dataNeeded: {
        type: "mixed",
        scope: "all",
      },
      shouldEscalate: true,
      escalationReason: "User needs coaching after seeing transaction data",
    };
  }

  // Default to Mill for data retrieval
  return {
    targetAgent: "mill",
    confidence: "medium",
    reasoning: "Query appears to request transaction data",
    dataNeeded: {
      type: "raw_transactions",
      scope: "all",
    },
    shouldEscalate: false,
  };
}

/**
 * Quick helpers to check query type
 */
export function isDataQuery(query: string): boolean {
  const routing = createFallbackRouting(query);
  return routing.targetAgent === "mill" && !routing.shouldEscalate;
}

export function isCoachingQuery(query: string): boolean {
  const routing = createFallbackRouting(query);
  return routing.targetAgent === "chatur";
}

export function needsEscalation(query: string): boolean {
  const routing = createFallbackRouting(query);
  return routing.shouldEscalate;
}

/**
 * Format routing decision for user feedback
 */
export function formatRoutingDecision(routing: QueryRouting): string {
  const lines: string[] = [];

  lines.push(`🎯 Query Routing Decision:`);
  lines.push(`   Target Agent: ${routing.targetAgent.toUpperCase()}`);
  lines.push(`   Confidence: ${routing.confidence}`);
  lines.push(`   Reasoning: ${routing.reasoning}`);
  lines.push(``);
  lines.push(`📊 Data Requirements:`);
  lines.push(`   Type: ${routing.dataNeeded.type}`);
  lines.push(`   Scope: ${routing.dataNeeded.scope}`);

  if (routing.dataNeeded.filters && Object.keys(routing.dataNeeded.filters).length > 0) {
    lines.push(`   Filters: ${JSON.stringify(routing.dataNeeded.filters)}`);
  }

  if (routing.shouldEscalate) {
    lines.push(``);
    lines.push(`🔄 Escalation: YES`);
    lines.push(`   Reason: ${routing.escalationReason}`);
  }

  return lines.join("\n");
}
