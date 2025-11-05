/**
 * Integrated Query Handler for Mill Agent
 * 
 * Smart query processing that:
 * 1. Routes to appropriate agent (Mill vs Chatur)
 * 2. Fetches appropriate data (transactions vs habits)
 * 3. Escalates when needed
 */

import { routeQuery, formatRoutingDecision, type QueryRouting } from "./query-router.js";
import { handleTransactionQuery, type QueryResult } from "./transaction-query-handler.js";

export interface IntegratedQueryResult {
  routing: QueryRouting;
  handled: boolean;
  response: string;
  escalationNeeded: boolean;
  escalationContext?: {
    agent: "chatur";
    reason: string;
    dataProvided: any;
  };
}

/**
 * Process user query with intelligent routing
 */
export async function processUserQuery(
  userQuery: string,
  options: {
    showRouting?: boolean;
    csvPath?: string;
  } = {}
): Promise<IntegratedQueryResult> {
  // Step 1: Route the query
  console.log(`[mill-integrated] Routing query: "${userQuery}"`);
  const routing = await routeQuery(userQuery);
  console.log(`[mill-integrated] Routed to: ${routing.targetAgent}`);

  // Step 2: Handle based on routing
  if (routing.targetAgent === "chatur") {
    return {
      routing,
      handled: false,
      response: buildChaturRedirectMessage(userQuery, routing),
      escalationNeeded: true,
      escalationContext: {
        agent: "chatur",
        reason: routing.reasoning,
        dataProvided: null,
      },
    };
  }

  // Mill handles the query
  if (routing.targetAgent === "mill") {
    // Check what type of data is needed
    if (routing.dataNeeded.type === "raw_transactions") {
      // Pure data query - no escalation
      const queryResult = await handleTransactionQuery(userQuery, options.csvPath);

      let response = "";
      
      if (options.showRouting) {
        response += formatRoutingDecision(routing) + "\n\n";
        response += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";
      }

      response += queryResult.userMessage;

      return {
        routing,
        handled: true,
        response,
        escalationNeeded: false,
        escalationContext: {
          agent: "chatur",
          reason: "Data retrieved successfully",
          dataProvided: queryResult.summary,
        },
      };
    }

    if (routing.dataNeeded.type === "mixed") {
      // Mixed query: Show data THEN offer escalation
      const queryResult = await handleTransactionQuery(userQuery, options.csvPath);

      let response = "";
      
      if (options.showRouting) {
        response += formatRoutingDecision(routing) + "\n\n";
        response += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";
      }

      response += queryResult.userMessage;

      // Always add escalation prompt for mixed queries
      response += "\n\n" + buildEscalationPrompt(routing);

      return {
        routing,
        handled: true,
        response,
        escalationNeeded: true,
        escalationContext: {
          agent: "chatur",
          reason: routing.escalationReason || "User needs coaching advice",
          dataProvided: queryResult.summary,
        },
      };
    }

    if (routing.dataNeeded.type === "habit_analysis" || routing.dataNeeded.type === "spending_patterns") {
      // Check if query has a "show me" component
      const hasShowComponent = userQuery.toLowerCase().match(/show|list|display|what/);
      
      if (hasShowComponent) {
        // Provide basic transaction data first, then escalate
        const queryResult = await handleTransactionQuery(userQuery, options.csvPath);

        let response = "";
        
        if (options.showRouting) {
          response += formatRoutingDecision(routing) + "\n\n";
          response += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";
        }

        response += queryResult.userMessage;
        response += "\n\n" + buildHabitAnalysisEscalationPrompt(routing);

        return {
          routing,
          handled: true,
          response,
          escalationNeeded: true,
          escalationContext: {
            agent: "chatur",
            reason: "Query requires habit analysis which Chatur can access",
            dataProvided: queryResult.summary,
          },
        };
      }

      // Pure habit analysis - redirect to Chatur
      return {
        routing,
        handled: false,
        response: buildHabitAnalysisRedirectMessage(userQuery),
        escalationNeeded: true,
        escalationContext: {
          agent: "chatur",
          reason: "Query requires habit analysis which Chatur can access",
          dataProvided: null,
        },
      };
    }
  }

  // Fallback
  return {
    routing,
    handled: false,
    response: "I'm not sure how to help with that. Could you rephrase your question?",
    escalationNeeded: false,
  };
}

/**
 * Build message when redirecting to Chatur
 */
function buildChaturRedirectMessage(query: string, routing: QueryRouting): string {
  return `I understand you're looking for ${routing.dataNeeded.type === "coaching_advice" ? "financial advice" : "guidance"}.

This type of question is best handled by Chatur, our financial coach who specializes in:
- Understanding spending habits
- Providing personalized advice
- Helping with budgeting strategies
- Analyzing behavioral patterns

${routing.reasoning}

Would you like me to connect you with Chatur?`;
}

/**
 * Build message when habit analysis is needed
 */
function buildHabitAnalysisRedirectMessage(query: string): string {
  return `I can provide raw transaction data, but your question requires deeper habit analysis.

Chatur, our financial coach, has access to:
- Analyzed spending patterns (from Param)
- Habit snapshots with behavioral insights
- Recommendations based on your history
- Trend analysis over time

For the best answer, I recommend asking Chatur this question.

Would you like me to forward this to Chatur?`;
}

/**
 * Build escalation prompt when both data and coaching needed
 */
function buildEscalationPrompt(routing: QueryRouting): string {
  return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📈 **Want deeper insights?**

Based on your question, you might benefit from Chatur's analysis:
- Pattern recognition in your spending
- Personalized recommendations
- Habit-based coaching

${routing.escalationReason}

Type "yes" to connect with Chatur for financial coaching.`;
}

/**
 * Build escalation prompt when habit analysis is specifically needed
 */
function buildHabitAnalysisEscalationPrompt(routing: QueryRouting): string {
  return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 **I've shown you the raw data above.**

For deeper analysis of your spending behavior, Chatur can help with:
- ✅ Habit pattern analysis (from Param's tracking)
- ✅ Overspending detection and alerts
- ✅ Personalized budget recommendations
- ✅ Behavioral insights and trends

Would you like me to connect you with Chatur for a detailed analysis?`;
}

/**
 * Quick helper: Just get data without routing details
 */
export async function getTransactionDataQuick(userQuery: string, csvPath?: string): Promise<string> {
  const options: { showRouting: boolean; csvPath?: string } = { showRouting: false };
  if (csvPath) {
    options.csvPath = csvPath;
  }
  const result = await processUserQuery(userQuery, options);
  return result.response;
}

/**
 * Quick helper: Check if query should go to Chatur
 */
export async function shouldRouteToChatur(userQuery: string): Promise<boolean> {
  const routing = await routeQuery(userQuery);
  return routing.targetAgent === "chatur" || routing.shouldEscalate;
}
