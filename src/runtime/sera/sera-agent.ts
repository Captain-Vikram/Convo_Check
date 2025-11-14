/**
 * Sera Agent - Product Shopping Assistant
 * 
 * Specializes in:
 * - Product search and comparison
 * - Price tracking and wishlist management
 * - Shopping recommendations for Indian e-commerce
 */

import { generateText, streamText, type LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import {
  searchShoppingTool,
  amazonProductLookupTool,
  addToWishlistTool,
  viewWishlistTool,
  getProductDetailsTool,
  type SearchResult,
} from '../../tools/sera.js';
import { logger } from '../shared/logger.js';
import { getAgentConfig } from '../../config.js';
import { SERA_SYSTEM_PROMPT } from './system-prompt.js';

export interface SeraConversation {
  sessionId: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  lastSearchResults?: SearchResult[];
  createdAt: string;
}

export interface SeraStartOptions {
  initialGreeting?: string;
}

export interface SeraContinueOptions {
  onSearchCompleted?: (results: SearchResult[]) => void;
}

const MAX_HISTORY = 20;

export class SeraAgent {
  private sessions = new Map<string, SeraConversation>();
  private readonly model: LanguageModel | null;
  private readonly initErrorMessage: string | undefined;

  constructor() {
    let resolvedModel: LanguageModel | null = null;
    let errorMessage: string | undefined;

    try {
      const { apiKey, model } = getAgentConfig('agent5');
      const provider = createGoogleGenerativeAI({ apiKey });
      resolvedModel = provider(model);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('sera', 'Initialization error', error);
    }

    this.model = resolvedModel;
    this.initErrorMessage = errorMessage;
  }

  /**
   * Start a new shopping conversation
   */
  startConversation(options: SeraStartOptions = {}): SeraConversation {
    this.getModelOrThrow();
    const sessionId = this.generateSessionId();
    const greeting =
      options.initialGreeting ||
      "Hey! 👋 I'm Sera, your shopping buddy! Looking for something specific today? Let me help you find the perfect product! 🛍️";

    const conversation: SeraConversation = {
      sessionId,
      messages: [
        {
          role: 'assistant',
          content: greeting,
        },
      ],
      createdAt: new Date().toISOString(),
    };

    this.sessions.set(sessionId, conversation);
    logger.debug('sera', `Started new conversation: ${sessionId}`);

    return conversation;
  }

  /**
   * Continue existing conversation with user input
   */
  async continueConversation(
    sessionId: string,
    userMessage: string,
    options: SeraContinueOptions = {}
  ): Promise<{
    message: string;
    completed: boolean;
    searchResults?: SearchResult[];
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Add user message to history
    session.messages.push({
      role: 'user',
      content: userMessage,
    });

    // Keep only last MAX_HISTORY messages
    if (session.messages.length > MAX_HISTORY) {
      session.messages = session.messages.slice(-MAX_HISTORY);
    }

    try {
      const model = this.getModelOrThrow();
      // Create enhanced tools with session context
      const enhancedGetProductDetails = this.createContextualProductDetailsTool(session);

      logger.debug('sera', `Calling generateText with user message: "${userMessage}"`);

      // Generate response with tools
      const result = await generateText({
        model,
        system: SERA_SYSTEM_PROMPT,
        messages: session.messages,
        tools: {
          searchShopping: searchShoppingTool,
          amazonProductLookup: amazonProductLookupTool,
          addToWishlist: addToWishlistTool,
          viewWishlist: viewWishlistTool,
          getProductDetails: enhancedGetProductDetails,
        },
      });

      logger.debug('sera', `generateText completed. Text: "${result.text?.substring(0, 100)}..."`);

      const assistantMessage = result.text;

      // Check if search was performed and store results
      let searchResults: SearchResult[] | undefined;
      const toolResults = (result as any).toolResults as Array<{
        toolName?: string;
        result?: unknown;
      }> | undefined;

      if (Array.isArray(toolResults)) {
        for (const toolResult of toolResults) {
          if (toolResult?.toolName === 'searchShopping' && toolResult.result) {
            const callResult = toolResult.result as { results?: unknown };
            if (Array.isArray(callResult.results)) {
              searchResults = callResult.results as SearchResult[];
              session.lastSearchResults = searchResults;

              if (options.onSearchCompleted) {
                options.onSearchCompleted(searchResults);
              }
            }
          }
        }
      }

      // Add assistant response to history
      session.messages.push({
        role: 'assistant',
        content: assistantMessage,
      });

      // Conversation is completed if user says goodbye or thanks explicitly
      const completed = /^(bye|goodbye|thanks?|thank you|that's all|exit|quit)$/i.test(
        userMessage.trim()
      );

      const response: {
        message: string;
        completed: boolean;
        searchResults?: SearchResult[];
      } = {
        message: assistantMessage,
        completed,
      };

      if (searchResults) {
        response.searchResults = searchResults;
      }

      return response;
    } catch (error: any) {
      const normalizedError = this.normalizeError(error);
      logger.error('sera', 'Conversation error', error);
      throw normalizedError;
    }
  }

  /**
   * Stream conversation response (for better UX)
   */
  async *streamConversation(sessionId: string, userMessage: string): AsyncGenerator<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.messages.push({
      role: 'user',
      content: userMessage,
    });

    if (session.messages.length > MAX_HISTORY) {
      session.messages = session.messages.slice(-MAX_HISTORY);
    }

    try {
      const model = this.getModelOrThrow();
      const enhancedGetProductDetails = this.createContextualProductDetailsTool(session);

      const result = streamText({
        model,
        system: SERA_SYSTEM_PROMPT,
        messages: session.messages,
        tools: {
          searchShopping: searchShoppingTool,
          amazonProductLookup: amazonProductLookupTool,
          addToWishlist: addToWishlistTool,
          viewWishlist: viewWishlistTool,
          getProductDetails: enhancedGetProductDetails,
        },
      });

      let fullResponse = '';
      for await (const chunk of result.textStream) {
        fullResponse += chunk;
        yield chunk;
      }

      session.messages.push({
        role: 'assistant',
        content: fullResponse,
      });
    } catch (error: any) {
      const normalizedError = this.normalizeError(error);
      logger.error('sera', 'Stream error', error);
      throw normalizedError;
    }
  }

  /**
   * Get conversation session
   */
  getSession(sessionId: string): SeraConversation | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * End a conversation session
   */
  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    logger.debug('sera', `Ended conversation: ${sessionId}`);
  }

  /**
   * Alias for endSession to match other agents' interface
   */
  endConversation(sessionId: string, reason?: string): void {
    this.endSession(sessionId);
    if (reason) {
      logger.debug('sera', `Conversation ended: ${reason}`);
    }
  }

  /**
   * Cleanup old sessions that have expired
   */
  cleanupOldSessions(maxAgeMs: number = 3600_000): void {
    const now = Date.now();
    const expiredSessions: string[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      const sessionAge = now - new Date(session.createdAt).getTime();
      if (sessionAge > maxAgeMs) {
        expiredSessions.push(sessionId);
      }
    }

    expiredSessions.forEach((sessionId) => {
      this.endSession(sessionId);
    });

    if (expiredSessions.length > 0) {
      logger.info('sera', `Cleaned up ${expiredSessions.length} expired sessions`);
    }
  }

  /**
   * Create getProductDetails tool with session context
   */
  private createContextualProductDetailsTool(session: SeraConversation) {
    const createTool = getProductDetailsTool as any;

    return {
      ...createTool,
      execute: async (params: { productReference: string }) => {
        const { productReference } = params;
        const results = session.lastSearchResults;

        if (!results || results.length === 0) {
          return {
            success: false,
            message: 'No recent search results available. Please search for products first.',
          };
        }

        // Parse product reference
        const product = this.findProductByReference(productReference, results);
        if (!product) {
          return {
            success: false,
            message: `Could not find product matching "${productReference}". Try using a number like "#1", "#2", etc.`,
          };
        }

        return {
          success: true,
          product: {
            number: results.indexOf(product) + 1,
            title: product.title,
            link: product.link,
            price: product.price || 'N/A',
            priceNumeric: product.price ? parseFloat(product.price.replace(/[^\d.]/g, '')) : 0,
            rating: product.rating || 'N/A',
            source: product.source,
          },
        };
      },
    };
  }

  private getModelOrThrow(): LanguageModel {
    if (this.model) {
      return this.model;
    }

    const detail = this.initErrorMessage ?? 'Sera is not configured.';
    if (this.initErrorMessage?.includes('SERA_GEMINI_API_KEY')) {
      throw new Error(
        'Sera requires SERA_GEMINI_API_KEY in your environment to run. Add a valid Gemini API key and restart the CLI.'
      );
    }

    throw new Error(`Sera initialization failed: ${detail}`);
  }

  private normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      if (error.message.includes('Google Generative AI API key is missing')) {
        return new Error(
          'Sera requires SERA_GEMINI_API_KEY in your environment. Add the key to .env and restart the CLI.'
        );
      }

      return error;
    }

    return new Error(String(error));
  }

  /**
   * Find product in results by user reference
   */
  private findProductByReference(reference: string, results: SearchResult[]): SearchResult | null {
    const ref = reference.toLowerCase().trim();

    // Number reference: #1, #2, first, second, etc.
    const numberMatch = ref.match(/#?(\d+)/);
    if (numberMatch) {
      const indexToken = numberMatch[1];
      if (!indexToken) {
        return null;
      }

      const index = Number.parseInt(indexToken, 10) - 1;
      return results[index] ?? null;
    }

    // Word numbers
    const wordNumbers: Record<string, number> = {
      first: 0,
      second: 1,
      third: 2,
      fourth: 3,
      fifth: 4,
      last: results.length - 1,
    };
    if (wordNumbers[ref] !== undefined) {
      return results[wordNumbers[ref]] || null;
    }

    // Price-based: cheapest, most expensive
    if (ref.includes('cheap') || ref.includes('lowest price')) {
      return results.reduce((min, curr) => {
        const minPrice = min.price ? parseFloat(min.price.replace(/[^\d.]/g, '')) : Infinity;
        const currPrice = curr.price ? parseFloat(curr.price.replace(/[^\d.]/g, '')) : Infinity;
        return currPrice < minPrice ? curr : min;
      });
    }
    if (ref.includes('expensive') || ref.includes('priciest')) {
      return results.reduce((max, curr) => {
        const maxPrice = max.price ? parseFloat(max.price.replace(/[^\d.]/g, '')) : 0;
        const currPrice = curr.price ? parseFloat(curr.price.replace(/[^\d.]/g, '')) : 0;
        return currPrice > maxPrice ? curr : max;
      });
    }

    // Rating-based: best rated, highest rated
    if (ref.includes('best rated') || ref.includes('highest rated') || ref.includes('top rated')) {
      return results.reduce((max, curr) => {
        const maxRating = max.rating ? parseFloat(max.rating) : 0;
        const currRating = curr.rating ? parseFloat(curr.rating) : 0;
        return currRating > maxRating ? curr : max;
      });
    }

    // Store-based: amazon one, flipkart one
    const storeMatch = ref.match(/(amazon|flipkart|croma|myntra|ajio)/i);
    if (storeMatch) {
      const store = storeMatch[1];
      if (!store) {
        return null;
      }

      return (
        results.find((r) => r.source.toLowerCase().includes(store.toLowerCase())) ?? null
      );
    }

    return null;
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    return `sera_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }
}
