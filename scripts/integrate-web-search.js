/**
 * Integration Guide: Adding Web Search to Agents
 *
 * This guide shows how to add web search capabilities to Mill and Chatur agents.
 */
import { searchWeb, formatSearchResults, searchFinancialAdvice, createWebSearchTool } from "../tools/web-search.js";
// ============================================================================
// OPTION 1: Add to Mill (Chatbot Agent)
// ============================================================================
/**
 * Update src/agents/chatbot.ts to include web search tool
 */
/*
// Add to imports
import {
  createWebSearchTool,
  webSearchToolDefinition,
  type WebSearchExecutor,
} from "../tools/web-search.js";

// Add web_search to tools array
export const chatbotAgent: AgentDefinition = {
  ...descriptor,
  systemPrompt: SYSTEM_PROMPT,
  tools: [
    logCashTransactionToolDefinition,
    querySpendingSummaryToolDefinition,
    webSearchToolDefinition  // NEW
  ],
};

// Update createChatbotToolset function
export function createChatbotToolset(
  logExecutor: LogCashTransactionExecutor,
  summaryExecutor: QuerySpendingSummaryExecutor,
  searchExecutor: WebSearchExecutor,  // NEW
) {
  return {
    [logCashTransactionToolDefinition.name]: createLogCashTransactionTool(logExecutor),
    [querySpendingSummaryToolDefinition.name]: createQuerySpendingSummaryTool(summaryExecutor),
    [webSearchToolDefinition.name]: createWebSearchTool(searchExecutor),  // NEW
  } as const;
}
*/
// ============================================================================
// OPTION 2: Update Mill's System Prompt
// ============================================================================
/**
 * Update SYSTEM_PROMPT in src/agents/chatbot.ts
 */
/*
Add to Mill's capabilities section:

You have THREE powerful tools:
- log_cash_transaction: for logging new transactions
- query_spending_summary: for fetching ALL past transaction data, insights from Param analyst, and advice from Coach
- web_search: for searching the internet for financial tips, budgeting advice, and helpful resources

When to use web_search:
- User asks "how can I save money on food?" → Search for "best ways to save money on food"
- User asks "what's a good budget for gig workers?" → Search for "budgeting tips for gig workers"
- User asks "how do I start an emergency fund?" → Search for "emergency fund guide"
- User asks about specific financial concepts → Search to provide accurate, helpful information

IMPORTANT: After showing search results, ask if they want to apply the advice to their situation!
*/
// ============================================================================
// OPTION 3: Integrate in chatbot-session.ts
// ============================================================================
/**
 * Update src/runtime/mill/chatbot-session.ts
 */
/*
import { searchWeb, formatSearchResults } from "../tools/web-search.js";

// In runChatbotSession, add web search executor
const tools = createChatbotToolset(
  async (payload) => {
    // ... existing log transaction logic
  },
  async () => {
    // ... existing query summary logic
  },
  async (query: string, maxResults?: number) => {  // NEW: Web search executor
    console.log(`[chatbot] Searching web for: "${query}"`);
    const results = await searchWeb(query, maxResults || 5);
    return results;
  }
);
*/
// ============================================================================
// OPTION 4: Add to Chatur (Coach Agent)
// ============================================================================
/**
 * Update src/runtime/chatur/chatur-coordinator.ts
 */
/*
import { searchFinancialAdvice, formatSearchResults } from "../../tools/web-search.js";

// In handleCoachingQuery, add web search capability
export async function handleCoachingQuery(
  userQuery: string,
  userId: string,
  routing?: QueryRouting,
  options: {
    sessionId?: string;
    csvPath?: string;
    enableWebSearch?: boolean;  // NEW
  } = {},
): Promise<{
  response: string;
  session: ChaturCoachingSession;
  dataUsed?: {
    transactions?: TransactionSummary;
    insights?: HabitInsight[];
  };
  webSearchResults?: WebSearchResult;  // NEW
}> {
  // ... existing code ...
  
  // Check if query needs web search
  if (options.enableWebSearch && shouldSearchWeb(userQuery)) {
    const searchResults = await searchFinancialAdvice(extractTopic(userQuery));
    // Include search results in coaching prompt
  }
  
  // ... rest of function ...
}

function shouldSearchWeb(query: string): boolean {
  const searchKeywords = [
    "how can i", "how do i", "how to",
    "what is", "what are",
    "tips for", "advice on",
    "best way", "best practices",
    "help me", "teach me",
  ];
  
  const lowerQuery = query.toLowerCase();
  return searchKeywords.some(kw => lowerQuery.includes(kw));
}

function extractTopic(query: string): string {
  // Simple topic extraction
  const cleanQuery = query
    .toLowerCase()
    .replace(/^(how can i|how do i|how to|what is|what are|tips for|advice on|best way|best practices|help me|teach me)/i, "")
    .trim();
  
  return cleanQuery || query;
}
*/
// ============================================================================
// EXAMPLE USAGE PATTERNS
// ============================================================================
/**
 * Example 1: User asks Mill for budgeting tips
 */
async function exampleMillUsage() {
    // User: "How can I save money on food?"
    // Mill uses web_search tool automatically
    const results = await searchWeb("best ways to save money on food for gig workers", 5);
    const formatted = formatSearchResults(results);
    // Mill responds:
    console.log(`
🔍 I found some great tips for you!

${formatted}

These are proven strategies from financial experts. Want me to help you apply 
any of these to your current food spending (₹5,400/month)?
  `);
}
/**
 * Example 2: Chatur uses search for coaching context
 */
async function exampleChaturUsage() {
    // User: "How can I build an emergency fund with irregular income?"
    const advice = await searchFinancialAdvice("emergency fund irregular income");
    // Chatur uses search results to enhance coaching:
    console.log(`
I looked up current best practices for your situation, and here's what experts recommend:

${advice.insights}

Now, let's adapt this to YOUR specific situation. You're earning ₹10k-14k/month 
with variation. Based on the research AND your data, here's my recommendation:

Phase 1: Start with ₹100/week in good weeks (builds ₹400/month)
Phase 2: Once you have ₹2,000 buffer, increase to ₹200/week
Phase 3: Target 1 month's expenses (₹12,000) as emergency fund

Want to dive deeper into any of these phases?
  `);
}
/**
 * Example 3: Direct search for specific topics
 */
async function exampleDirectSearch() {
    const topics = [
        "50/30/20 budget rule for gig workers",
        "best expense tracking apps free",
        "how to negotiate gig work rates",
        "tax deductions for freelancers India",
    ];
    for (const topic of topics) {
        const results = await searchWeb(topic, 3);
        console.log(`\nTopic: ${topic}`);
        console.log(`Found: ${results.totalResults} results`);
        console.log(formatSearchResults(results));
    }
}
// ============================================================================
// TESTING
// ============================================================================
/**
 * Test web search functionality
 */
export async function testWebSearch() {
    console.log("🧪 Testing Web Search Tool\n");
    // Test 1: DuckDuckGo search
    console.log("Test 1: DuckDuckGo search for budgeting tips");
    const result1 = await searchWeb("budgeting tips for gig workers", 3);
    console.log(formatSearchResults(result1));
    // Test 2: Financial advice search
    console.log("\nTest 2: Financial advice search");
    const result2 = await searchFinancialAdvice("save money on food");
    console.log(result2.summary);
    console.log(result2.insights);
    // Test 3: Error handling
    console.log("\nTest 3: Empty query");
    const result3 = await searchWeb("", 5);
    console.log(formatSearchResults(result3));
}
// Run test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    testWebSearch().catch(console.error);
}
//# sourceMappingURL=integrate-web-search.js.map