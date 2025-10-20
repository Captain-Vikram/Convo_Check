/**
 * Enhanced Query Handler with Natural Language Processing
 * 
 * Flow:
 * 1. User asks natural question
 * 2. Route query and fetch data from CSV
 * 3. Pass data to Mill's LLM for natural presentation
 * 4. Return chat-friendly response
 */

import { generateText } from "ai";
import { getAgentConfig, createLanguageModel } from "../../config.js";
import { processUserQuery, type IntegratedQueryResult } from "./integrated-query-handler.js";
import type { TransactionSummary } from "./transaction-reader.js";

export interface NaturalQueryResult {
  routing: IntegratedQueryResult["routing"];
  naturalResponse: string;
  rawData: TransactionSummary | null;
  escalationNeeded: boolean;
}

/**
 * Process query naturally through Mill's conversational layer
 */
export async function handleNaturalQuery(
  userQuery: string,
  options: {
    csvPath?: string;
    conversational?: boolean;
  } = {}
): Promise<NaturalQueryResult> {
  // Default to conversational mode
  const conversational = options.conversational !== false;

  // Step 1: Route and fetch data
  const queryOptions: { showRouting: boolean; csvPath?: string } = { showRouting: false };
  if (options.csvPath) {
    queryOptions.csvPath = options.csvPath;
  }
  const result = await processUserQuery(userQuery, queryOptions);

  // Step 2: If Mill handles it and we have data, make it conversational
  if (result.handled && conversational && result.escalationContext?.dataProvided) {
    const naturalResponse = await convertToNaturalResponse(
      userQuery,
      result.escalationContext.dataProvided,
      result.escalationNeeded
    );

    return {
      routing: result.routing,
      naturalResponse,
      rawData: result.escalationContext.dataProvided,
      escalationNeeded: result.escalationNeeded,
    };
  }

  // Step 3: For redirects or pure data, still make it friendly
  if (!result.handled && conversational) {
    const naturalResponse = await makeResponseFriendly(userQuery, result.response);
    
    return {
      routing: result.routing,
      naturalResponse,
      rawData: null,
      escalationNeeded: result.escalationNeeded,
    };
  }

  // Fallback: return as-is
  return {
    routing: result.routing,
    naturalResponse: result.response,
    rawData: result.escalationContext?.dataProvided || null,
    escalationNeeded: result.escalationNeeded,
  };
}

/**
 * Convert raw transaction data into natural, chat-friendly response using Mill's LLM
 */
async function convertToNaturalResponse(
  userQuery: string,
  transactionData: TransactionSummary,
  needsCoachingSuggestion: boolean
): Promise<string> {
  const systemPrompt = `You are Mill, a friendly financial assistant chatbot helping gig workers track their money.

Your personality:
- Warm, supportive, and encouraging
- Use simple, conversational language
- Avoid technical jargon
- Use emojis sparingly but appropriately
- Be concise but informative

Your role:
- Present transaction data in a natural, easy-to-understand way
- Highlight important patterns or insights
- Make numbers relatable (e.g., "That's about the cost of 3 meals")
- End with a friendly note or quick tip

IMPORTANT RULES:
1. NEVER use technical terms like "debits", "credits" - say "spent", "earned", "received"
2. NEVER say "transaction" - say "payment", "expense", "income"
3. Present numbers naturally: "You spent ₹339" not "Total Debits: 339.00"
4. Group similar transactions: "You paid that merchant 3 times" instead of listing each
5. Be encouraging about good habits, gentle about spending patterns
6. If net amount is positive, celebrate it! If negative, acknowledge it supportively

Format your response as a friendly chat message, not a report.`;

  const userPrompt = `User asked: "${userQuery}"

Here's the transaction data:
- Time period: ${transactionData.dateRange.from} to ${transactionData.dateRange.to}
- Total transactions: ${transactionData.totalTransactions}
- Total spent: ₹${transactionData.totalDebits}
- Total earned/received: ₹${transactionData.totalCredits}
- Net: ${transactionData.netAmount >= 0 ? `+₹${transactionData.netAmount}` : `-₹${Math.abs(transactionData.netAmount)}`}

Transactions:
${transactionData.transactions.map(tx => 
  `- ${tx.date}: ${tx.type === 'debit' ? 'Paid' : 'Received'} ₹${tx.amount}${tx.targetParty ? ` ${tx.type === 'debit' ? 'to' : 'from'} ${tx.targetParty}` : ''}`
).join('\n')}

${needsCoachingSuggestion ? '\nNote: User may benefit from spending analysis/coaching from Chatur.' : ''}

Create a natural, conversational response that:
1. Directly answers their question
2. Highlights interesting patterns (e.g., recurring payments, big expenses)
3. Uses friendly language
4. ${needsCoachingSuggestion ? 'Gently suggests they could get coaching insights if interested' : 'Ends with an encouraging note'}

Keep it under 200 words.`;

  try {
    const config = getAgentConfig("agent1");
    const languageModel = createLanguageModel(config);

    const result = await generateText({
      model: languageModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return result.text.trim();
  } catch (error) {
    console.error("[mill-natural] Failed to generate natural response", error);
    // Fallback to simple format
    return formatSimpleNaturalResponse(transactionData, needsCoachingSuggestion);
  }
}

/**
 * Make redirect/error messages more friendly
 */
async function makeResponseFriendly(
  userQuery: string,
  technicalResponse: string
): Promise<string> {
  const systemPrompt = `You are Mill, a friendly financial assistant chatbot.

Convert technical/formal messages into warm, conversational responses.

Rules:
- Keep the core information
- Make it sound like a friend talking
- Use "I" statements
- Be supportive and helpful
- No bullet points or technical formatting`;

  const userPrompt = `User asked: "${userQuery}"

System response: "${technicalResponse}"

Rewrite this as a friendly chat message from Mill (max 100 words).`;

  try {
    const config = getAgentConfig("agent1");
    const languageModel = createLanguageModel(config);

    const result = await generateText({
      model: languageModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return result.text.trim();
  } catch (error) {
    console.error("[mill-natural] Failed to make response friendly", error);
    return technicalResponse;
  }
}

/**
 * Fallback simple natural response if LLM fails
 */
function formatSimpleNaturalResponse(
  data: TransactionSummary,
  needsCoaching: boolean
): string {
  if (data.totalTransactions === 0) {
    return "I checked, but didn't find any transactions for that period. 🤔";
  }

  const lines: string[] = [];
  
  // Opening
  lines.push(`Here's what I found! 📊\n`);

  // Summary
  const period = `from ${data.dateRange.from} to ${data.dateRange.to}`;
  lines.push(`Between ${period}, you had ${data.totalTransactions} transactions:\n`);

  // Money summary
  if (data.totalDebits > 0) {
    lines.push(`💸 You spent ₹${data.totalDebits.toFixed(2)}`);
  }
  if (data.totalCredits > 0) {
    lines.push(`💰 You received ₹${data.totalCredits.toFixed(2)}`);
  }

  // Net
  if (data.netAmount > 0) {
    lines.push(`\n✨ Great! You're up by ₹${data.netAmount.toFixed(2)}`);
  } else if (data.netAmount < 0) {
    lines.push(`\nNet: -₹${Math.abs(data.netAmount).toFixed(2)}`);
  }

  // Recent transactions (max 5)
  const recent = data.transactions.slice(0, 5);
  lines.push(`\nRecent activity:`);
  for (const tx of recent) {
    const emoji = tx.type === 'debit' ? '🔴' : '🟢';
    const action = tx.type === 'debit' ? 'Paid' : 'Got';
    lines.push(`${emoji} ${action} ₹${tx.amount} on ${tx.date}`);
  }

  if (data.transactions.length > 5) {
    lines.push(`... and ${data.transactions.length - 5} more`);
  }

  // Coaching suggestion
  if (needsCoaching) {
    lines.push(`\n💡 Want me to analyze your spending patterns? I can connect you with Chatur for personalized tips!`);
  }

  return lines.join('\n');
}

/**
 * Quick helper for chat interface
 */
export async function chatQuery(userMessage: string): Promise<string> {
  const result = await handleNaturalQuery(userMessage, { conversational: true });
  return result.naturalResponse;
}
