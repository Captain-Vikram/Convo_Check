import { randomUUID } from "node:crypto";
import { coachAgent } from "@/agents/coach";
// TODO: Param agent is stubbed
// import type { HabitInsight } from "../param/analyst-agent";
type HabitInsight = any;
import { getCircuitBreaker, withRetry } from "../shared/error-handling";
import { BaseConversationalAgent, type ConversationSession, type ConversationOptions } from "../shared/base-agent";
import type { AgentInput } from "../shared/multimodal";
import { normalizeAgentInput, summarizeInputForHistory, buildMultimodalContent } from "../shared/multimodal";
import type { CoreMessage } from "ai";
import { createWebSearchTool, searchWeb } from "../../tools/web-search";
import { createFinancialCalculatorTool } from "../../tools/financial-calculator";
import type { SpendingSummaryResult } from "../../tools/query-spending-summary";

/**
 * Conversational session with Coach for interactive guidance
 */
export interface CoachConversation extends ConversationSession<Record<string, unknown>> {
  insights: HabitInsight[];
  financialSummary?: SpendingSummaryResult;
  recentTransactions?: any[];
  pastBriefings?: any[];
  currentQuestion?: string;
}

export interface CoachConversationOptions extends ConversationOptions {
  insights: HabitInsight[];
  financialSummary?: SpendingSummaryResult;
  recentTransactions?: any[];
  pastBriefings?: any[];
  initialQuestion?: string;
  collectedInfo?: Record<string, unknown>;
}

export class ConversationalCoach extends BaseConversationalAgent<CoachConversation> {
  private circuitBreaker = getCircuitBreaker("coach-llm", {
    failureThreshold: 3,
    timeout: 20_000,
  });

  constructor() {
    super({
      agentId: "agent4",
      systemPrompt: coachAgent.systemPrompt,
      temperature: 0.8,
      maxTokens: 1500,
      maxSessionAgeMs: 3600_000,
    });
  }

  /**
   * Create a new coach conversation session
   */
  protected createSession(sessionId: string, options: CoachConversationOptions): CoachConversation {
    const session: CoachConversation = {
      sessionId,
      startedAt: new Date().toISOString(),
      insights: options.insights,
      financialSummary: options.financialSummary,
      recentTransactions: options.recentTransactions,
      pastBriefings: options.pastBriefings,
      messages: [],
      state: "active",
      collectedInfo: {},
    };
    
    if (options.initialQuestion) {
      session.currentQuestion = options.initialQuestion;
    }
    
    return session;
  }

  /**
   * Start a new conversational session with the coach
   */
  startConversation(options: CoachConversationOptions): CoachConversation {
    const session = super.startConversation(options);
    
    // Start with initial question if provided
    if (options.initialQuestion) {
      session.currentQuestion = options.initialQuestion;
      // Message is already added by parent if initialMessage is set
      if (!options.initialMessage) {
        session.messages.push({
          role: "assistant",
          content: options.initialQuestion,
          timestamp: new Date().toISOString(),
        });
      }
    }

    return session;
  }

  /**
   * Continue a conversation with user response
   */
  async continueConversation(
    sessionId: string,
    userResponse: string | AgentInput,
    contextUpdate?: Partial<CoachConversationOptions>
  ): Promise<{
    message: string;
    completed: boolean;
    guidance?: CoachGuidance;
    shouldEscalateToMill?: boolean;
  }> {
  // In stateless mode the router may not hydrate sessions here.
  // Use an ephemeral session object and avoid modifying shared activeSessions map.
  const effectiveSessionId = sessionId || randomUUID();
  const session = this.createSession(effectiveSessionId, { insights: [], initialQuestion: undefined } as any);

    // Update session context if provided
    if (contextUpdate) {
      if (contextUpdate.insights) session.insights = contextUpdate.insights;
      if (contextUpdate.financialSummary) session.financialSummary = contextUpdate.financialSummary;
      if (contextUpdate.recentTransactions) session.recentTransactions = contextUpdate.recentTransactions;
      if (contextUpdate.pastBriefings) session.pastBriefings = contextUpdate.pastBriefings;
      if ((contextUpdate as any).collectedInfo) Object.assign(session.collectedInfo, (contextUpdate as any).collectedInfo);
    }

    const normalizedInput = normalizeAgentInput(userResponse);
    const summarized = summarizeInputForHistory(normalizedInput);

    const userEntry: CoachConversation["messages"][number] = {
      role: "user",
      content: summarized,
      timestamp: new Date().toISOString(),
    };
    if (normalizedInput.attachments && normalizedInput.attachments.length > 0) {
      userEntry.attachments = normalizedInput.attachments;
    }
    session.messages.push(userEntry);

    // Generate coach response using LLM
    const result = await this.generateCoachResponse(session, normalizedInput);

    // Check if should escalate to Mill
    if (result.shouldEscalateToMill) {
  // Stateless handling: don't mutate persistent session state; return completed
      return {
        message:
          result.message +
          " Let me connect you with Mill who can help you log that transaction. 📝",
        completed: true,
        shouldEscalateToMill: true,
      };
    }

    // Add assistant message
    session.messages.push({
      role: "assistant",
      content: result.message,
      timestamp: new Date().toISOString(),
    });

    // Update collected info if provided
    if (result.extractedInfo) {
      Object.assign(session.collectedInfo, result.extractedInfo);
    }

    // Check if conversation is complete
    if (result.completed) {
  // Stateless: do not mark stored session as completed. Keep ephemeral session but indicate completed to caller.
      
      // If the result itself contains guidance fields (from JSON output), use them
      let guidance: CoachGuidance | undefined;
      if (result.extractedInfo && (result.extractedInfo as any).headline) {
          guidance = {
              headline: (result.extractedInfo as any).headline,
              counsel: (result.extractedInfo as any).counsel || result.message,
              evidence: (result.extractedInfo as any).evidence || "Conversation-based",
              conversationSummary: session.messages.filter(m => m.role === "user").map(m => m.content).join(" | ")
          };
      } else if ((result as any).headline) { // Check if result has top-level guidance fields
           guidance = {
              headline: (result as any).headline,
              counsel: (result as any).counsel || result.message,
              evidence: (result as any).evidence || "Conversation-based",
              conversationSummary: session.messages.filter(m => m.role === "user").map(m => m.content).join(" | ")
          };
      } else {
          guidance = await this.generateFinalGuidance(session);
      }

      return { message: result.message, completed: true, guidance };
    }

    // Update current question
    if (result.nextQuestion) {
      session.currentQuestion = result.nextQuestion;
    }

    return { message: result.message, completed: false };
  }

  /**
   * Generate coach response using LLM with error handling
   */
  private async generateCoachResponse(
    session: CoachConversation,
    latestInput?: AgentInput,
  ): Promise<{
    message: string;
    completed: boolean;
    nextQuestion?: string;
    extractedInfo?: Record<string, unknown>;
    shouldEscalateToMill?: boolean;
  }> {
    const prompt = this.buildConversationalPrompt(session);
    const messages: any[] = [
      { role: "system", content: this.getConversationalSystemPrompt() + this.getChainDirective() },
      { role: "user", content: prompt },
    ];

    if (latestInput) {
      messages.push({
        role: "user",
        content: buildMultimodalContent(latestInput),
      });
    }

    try {
      return await this.circuitBreaker.execute(
        async () => {
          return withRetry(
            async () => {
              const result = await this.callLLM({
                messages: messages as CoreMessage[],
                tools: {
                  webSearch: createWebSearchTool(searchWeb),
                  financialCalculator: createFinancialCalculatorTool(),
                },
                maxSteps: 5,
              });

              console.log('[coach] LLM Raw Result:', result.text);
              const text = (result.text ?? "").trim();

              if (!text) {
                throw new Error("Empty response from LLM");
              }

              // Parse initial response
              const parsed = this.parseConversationalResponse(text);

              // If the assistant asked for data that we already have in session.collectedInfo,
              // perform one automatic re-run by injecting known data to steer the model.
              const probeRegex = /\b(income|savings|how much|what is your income|what is your savings|do you have)\b/i;
              const hasProbe = probeRegex.test(parsed.message || "") && Object.keys(session.collectedInfo || {}).length > 0;

              if (hasProbe) {
                const knownParts: string[] = [];
                const ci = session.collectedInfo || {};
                if (ci.income) knownParts.push(`Income: ₹${ci.income}`);
                if (ci.savings) knownParts.push(`Savings: ₹${ci.savings}`);
                if (ci.amount) knownParts.push(`Amount: ₹${ci.amount}`);
                if (ci.goal) knownParts.push(`Goal: ${ci.goal}`);

                if (knownParts.length > 0) {
                  const followUpMessages = messages.slice();
                  followUpMessages.push({ role: 'user', content: `KNOWN_DATA: ${knownParts.join('; ')}. Please re-answer using these values without further probing.` });

                  const rerun = await this.callLLM({
                    messages: followUpMessages as CoreMessage[],
                    tools: {
                      webSearch: createWebSearchTool(searchWeb),
                      financialCalculator: createFinancialCalculatorTool(),
                    },
                    maxSteps: 5,
                  });

                  const rerunText = (rerun.text ?? "").trim();
                  if (rerunText) {
                    return this.parseConversationalResponse(rerunText);
                  }
                }
              }

              return parsed;
            },
            { 
              maxAttempts: 3,
              initialDelayMs: 2000,  // Start with 2s delay
              maxDelayMs: 15000,     // Up to 15s for overload errors
              backoffMultiplier: 2,
            },
            (error: unknown) => {
              // Retry on overload errors specifically
              const message = error instanceof Error ? error.message : String(error);
              const isOverloaded = message.toLowerCase().includes('overload');
              if (isOverloaded) {
                console.log('[coach] Model overloaded, will retry with longer delay...');
              }
              return true; // Retry all errors within attempt limit
            },
          );
        },
        async () => {
          // Fallback to rule-based response
          return this.fallbackResponse(session);
        },
      );
    } catch (error) {
      console.error("[coach] Failed to generate conversational response", error);
      return this.fallbackResponse(session);
    }
  }

  private getConversationalSystemPrompt(): string {
    return `${coachAgent.systemPrompt}

You are Chatur in CONVERSATIONAL mode. Your specialized role:
- Provide personalized financial advice and coaching
- Help users set and achieve financial goals
- Offer motivational support and habit improvement strategies
- Tailor guidance for gig workers and irregular income scenarios

UNDERSTAND YOUR ROLE VS MILL:
- **You (Chatur)**: Financial advice, budgeting tips, goal setting, motivation, "what should I do"
- **Mill**: Transaction logging, data queries, coordination
- If user asks to log transactions or check spending data → suggest they talk to Mill
- Focus on: advice, guidance, planning, goals, habits, motivation

CONVERSATIONAL STRATEGY:
1. Ask clarifying questions about goals, challenges, priorities
2. Gather context: income patterns, spending habits, constraints
3. Extract information: goals (save/reduce spending), problem areas, timeline
4. After 2-4 turns, provide personalized action plan
5. Keep responses concise (2-3 sentences), encouraging, practical
6. Use evidence from insights to ground advice
7. **AUTONOMOUS PERSONALIZATION**: If you have the "Financial Snapshot", use it to proactively suggest budgets or savings goals without asking generic questions. E.g., "Since you have a surplus of ₹5,000, maybe invest ₹2,000?"
8. **REAL-TIME INFO**: Use the 'webSearch' tool to find up-to-date info on investments, companies, stocks, or financial concepts.
9. **ACCURATE MATH**: Use the 'financialCalculator' tool for ANY calculation (budget splits, SIP projections, loan EMIs). Do not do math in your head.
10. **CONTEXT AWARENESS**: Use "Recent Transactions" and "Past Advice" to make your responses highly relevant. Don't give generic advice if you see specific spending patterns.

Respond with a helpful message.

Additional Mandatory Rules (READ CAREFULLY):
- MANDATORY: For all numeric/financial calculations (SIP, EMI, affordability, budget splits), call the 'financialCalculator' tool and include the computed result in your response. Do not approximate numbers manually.
- MANDATORY: Reference 1-2 relevant insights from the provided "Latest financial insights" in every personalized response when such insights exist. Use their evidence to ground recommendations (e.g., "Because Insight #1 shows...",
  and cite briefly).
- MANDATORY: If the user's message contains explicit numbers (income, savings, price), extract them and compute answers directly rather than asking for them again, unless the values are ambiguous or missing.

KEY RULES:
- If user says "log this" or "I spent X" → set shouldEscalateToMill: true
- Focus on WHY and HOW, not just WHAT (that's Mill's job)
- Use insights to personalize advice
- Be optimistic but realistic for gig worker context`;
  }

  // Small helper to append mandatory chain instruction to system prompt (keeps intent clear)
  private getChainDirective(): string {
    return `\n\nCHAIN: 1) Extract numbers from EXTRACTED DATA and the user's query. 2) Use the financialCalculator tool for any numeric computation (SIP/EMI/affordability). 3) Personalize the recommendation using 1-2 insights above. 4) Deliver an actionable plan with steps and a timeline. Do NOT probe for data already present in EXTRACTED DATA.`;
  }

  private buildConversationalPrompt(session: CoachConversation): string {
    const insights = session.insights || [];
    const fsnap = session.financialSummary || { totalIncome: 0, totalExpense: 0, netBalance: 0, topCategories: [] as any[] };

    const recentTxs = (session.recentTransactions || []).slice(0, 5).map((tx: any) => {
      const date = tx.date_of_transaction ? new Date(tx.date_of_transaction).toLocaleDateString() : 'unknown';
      return `- ${date}: ${tx.description} ₹${tx.amount} (${tx.category || 'uncategorized'})`;
    }).join('\n');

    const pastBriefings = (session.pastBriefings || []).slice(0, 2).map((b: any) => `- ${b.headline}: ${b.counsel}`).join('\n');

    const history = (session.messages || []).map(m => `${m.role === 'user' ? 'User' : 'Coach'}: ${m.content}`).join('\n');

    // Determine current question: prefer session.currentQuestion, else last user message
    const currentQuestion = session.currentQuestion || (session.messages && [...session.messages].reverse().find(m => m.role === 'user')?.content) || '';

    const insightBlock = insights.length > 0
      ? insights.map((i: any, idx: number) => `${idx + 1}. ${i.habitLabel || i.habit_label || 'Insight'}: ${i.fullText || i.full_text || (i.evidence || '')} (Evidence: ${i.evidence || ''}; Counsel: ${i.counsel || ''})`).join('\n\n')
      : 'No insights yet – build from snapshot.';

    const extracted = session.collectedInfo || {};

    const topCategories = (fsnap.topCategories || []).map((c: any) => `${c.category || c.name}: ₹${c.totalSpent ?? c.total ?? c.amount ?? 0}`).join(', ') || 'none';

    return `CRITICAL: PERSONALIZE EVERY RESPONSE USING THESE INSIGHTS (REFERENCE 1-2 WITH EVIDENCE):\n${insightBlock}\n\nEXTRACTED DATA: Income ₹${extracted.income ?? 'unknown'}, Savings ₹${extracted.savings ?? 'unknown'}, Goal: ${extracted.goal ?? 'none'}.\n\nSnapshot: Income ₹${fsnap.totalIncome}, Expense ₹${fsnap.totalExpense}, Balance ₹${fsnap.netBalance}.\nTop Categories: ${topCategories}.\n\nRecent Txs (use for examples):\n${recentTxs || 'none'}\n\nPast Advice:\n${pastBriefings || 'none'}\n\nConversation:\n${history || 'none'}\n\nQuery: ${currentQuestion}\n\nRULES:\n- If query has numbers/goal, use financialCalculator IMMEDIATELY (e.g., SIP/EMI/savings plan).\n- ALWAYS tie to 1 insight (e.g., \"From coffee habit insight...\").\n- Deliver plan in 3 steps if data sufficient – NO probing.\n- Output JSON if calc: {"headline": "...", "plan": ["step1", "step2"], "calc": {...}}\n`.trim();
  }

  private parseConversationalResponse(text: string): {
    message: string;
    completed: boolean;
    nextQuestion?: string;
    extractedInfo?: Record<string, unknown>;
    shouldEscalateToMill?: boolean;
  } {
    try {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const jsonText = jsonMatch ? jsonMatch[1]!.trim() : text;

      const startIdx = jsonText.indexOf("{");
      const endIdx = jsonText.lastIndexOf("}");
      if (startIdx === -1 || endIdx === -1) {
        throw new Error("No JSON found");
      }

      const parsed = JSON.parse(jsonText.slice(startIdx, endIdx + 1));
      
      // Check if this is a "decision" response (Coach Briefing format)
      if (parsed.decision || parsed.headline) {
          return {
              message: parsed.counsel || parsed.message || "Here is my advice.",
              completed: true, // Briefings usually end the turn
              extractedInfo: parsed, // Pass the whole object as info so we can extract guidance
              shouldEscalateToMill: false
          };
      }

      return {
        message: parsed.message ?? text,
        completed: parsed.completed ?? false,
        nextQuestion: parsed.nextQuestion,
        extractedInfo: parsed.extractedInfo,
        shouldEscalateToMill: parsed.shouldEscalateToMill ?? false,
      };
    } catch {
      // Attempt a lightweight extraction when JSON isn't present:
      try {
        const headlineMatch = text.match(/^(?:Headline:|HEADLINE:)?\s*([A-Za-z0-9\-\s,:]{5,100})/i);
        const counselMatch = text.match(/(?:Counsel:|Advice:|Recommendation:|Counsel\s*-?)\s*([\s\S]{20,500})/i);
        const shortSentences = text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
        const fallbackHeadline = headlineMatch?.[1] ?? (shortSentences[0] && shortSentences[0].length < 120 ? shortSentences[0] : undefined);
        const fallbackCounsel = counselMatch?.[1] ?? shortSentences.slice(1,3).join(' ');

        if (fallbackHeadline || fallbackCounsel) {
          const extracted: any = {
            headline: fallbackHeadline ?? undefined,
            counsel: fallbackCounsel ?? text,
          };

          return {
            message: extracted.counsel || text,
            completed: true,
            extractedInfo: extracted,
            shouldEscalateToMill: /log this|i spent|add transaction|save transaction/i.test(text),
          };
        }
      } catch (e) {
        // ignore
      }

      // Final fallback: treat entire text as message
      return { message: text, completed: false };
    }
  }

  private fallbackResponse(session: CoachConversation): {
    message: string;
    completed: boolean;
    nextQuestion?: string;
  } {
    const turnCount = session.messages.filter((m) => m.role === "user").length;

    if (turnCount === 0) {
      return {
        message: "Let me understand your financial goals better. What's your biggest priority right now - saving more, reducing expenses, or something else?",
        completed: false,
        nextQuestion: "What's your financial priority?",
      };
    }

    if (turnCount < 3) {
      return {
        message: "Thanks for sharing that! Based on your insights, I see some patterns. What would you like to focus on improving first?",
        completed: false,
        nextQuestion: "What area to improve?",
      };
    }

    // Complete after 3+ turns
    return {
      message: "Based on what you've shared, here's my advice: Focus on tracking your spending patterns and set a realistic budget. Start small and build consistent habits. You're on the right track!",
      completed: true,
    };
  }

  private async generateFinalGuidance(session: CoachConversation): Promise<CoachGuidance> {
    // Generate comprehensive guidance based on conversation
    const summary = session.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" | ");

    return {
      headline: "Personalized Plan",
      counsel: `Based on our conversation: ${summary.slice(0, 100)}`,
      evidence: session.insights[0]?.evidence ?? "Conversation-based",
      conversationSummary: summary,
    };
  }
}

export interface CoachGuidance {
  headline: string;
  counsel: string;
  evidence: string;
  conversationSummary?: string;
}
