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
  type SearchResult,
} from '../../tools/sera.js';
import { logger } from '../shared/logger.js';
import { getAgentConfig } from '../../config.js';
import { SERA_SYSTEM_PROMPT } from './system-prompt.js';
import { SeraSearchAdapter } from './search-adapter.js';
import { WishlistController, type WishlistCommand } from './wishlist-controller.js';
import {
  cloneSeraConversation,
  type SeraContinueOptions,
  type SeraConversation,
  type SeraContinuationResult,
  type SeraStartOptions,
} from './types.js';

export type { SeraConversation } from './types.js';

type ToolCallResult = {
  toolName?: string;
  result?: unknown;
};

const MAX_HISTORY = 20;

export class SeraAgent {
  private sessions = new Map<string, SeraConversation>();
  private readonly model: LanguageModel | null;
  private readonly initErrorMessage: string | undefined;
  private readonly searchAdapter: SeraSearchAdapter;
  private readonly wishlistController: WishlistController;

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
    this.searchAdapter = new SeraSearchAdapter();
    this.wishlistController = new WishlistController({
      findProductByReference: this.searchAdapter.findProductByReference.bind(this.searchAdapter),
      createSearchResultFromUrl: this.searchAdapter.createSearchResultFromUrl.bind(this.searchAdapter),
    });
  }

  /**
   * Start a new shopping conversation
   */
  startConversation(options: SeraStartOptions = {}): SeraConversation {
    this.getModelOrThrow();
    const sessionId = this.generateSessionId();
    const defaultGreeting =
      "I'm ready to help you shop! Tell me what you're looking for, your budget, or any must-haves, and I'll scout the best options.";
    const greeting = options.initialGreeting ?? defaultGreeting;
    const shouldSendGreeting = !options.suppressGreeting && typeof greeting === 'string' && greeting.trim().length > 0;

    const conversation: SeraConversation = {
      sessionId,
      messages: [],
      createdAt: new Date().toISOString(),
    };

    if (shouldSendGreeting) {
      conversation.messages.push({
        role: 'assistant',
        content: greeting,
      });
    }

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
  ): Promise<SeraContinuationResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const safeUserMessage = userMessage?.trim().length ? userMessage : '[No textual input provided]';

    session.messages.push({
      role: 'user',
      content: safeUserMessage,
    });

    // Keep only last MAX_HISTORY messages
    if (session.messages.length > MAX_HISTORY) {
      session.messages = session.messages.slice(-MAX_HISTORY);
    }

    this.wishlistController.captureReferenceFromMessage(session, safeUserMessage);

    const amazonUrl = this.searchAdapter.extractAmazonUrl(safeUserMessage);
    let wishlistCommand = this.wishlistController.detectCommand(session, safeUserMessage);

    const shouldDeferAddCommand =
      wishlistCommand?.type === 'add' &&
      !!amazonUrl &&
      !wishlistCommand.reference &&
      (!session.lastSearchResults || session.lastSearchResults.length === 0);

    if (shouldDeferAddCommand && wishlistCommand?.type === 'add') {
      session.pendingWishlistAction = {
        type: 'add',
        requestedAt: new Date().toISOString(),
      };

      if (wishlistCommand.desiredPrice) {
        session.pendingWishlistAction.desiredPrice = wishlistCommand.desiredPrice;
      }

      const productUrlForPending = wishlistCommand.productUrl ?? amazonUrl;
      if (productUrlForPending) {
        session.pendingWishlistAction.productUrl = productUrlForPending;
      }

      wishlistCommand = null;
    }

    if (wishlistCommand) {
      const responseMessage = await this.wishlistController.handleCommand(session, wishlistCommand);
      session.messages.push({
        role: 'assistant',
        content: responseMessage,
      });

      return {
        message: responseMessage,
        completed: false,
      };
    }

    // Amazon link detection – handle reverse search directly without planner
    if (amazonUrl) {
      const { message: responseMessage, searchResults } = await this.searchAdapter.handleAmazonLinkRequest(
        session,
        amazonUrl
      );
      session.messages.push({
        role: 'assistant',
        content: responseMessage,
      });

      const response: SeraContinuationResult = {
        message: responseMessage,
        completed: false,
      };

      if (searchResults && searchResults.length > 0) {
        response.searchResults = searchResults;
      } else if (session.lastSearchResults && session.lastSearchResults.length > 0) {
        response.searchResults = session.lastSearchResults;
      }

      return response;
    }

    try {
      const model = this.getModelOrThrow();
      // Create enhanced tools with session context
      const enhancedGetProductDetails = this.searchAdapter.createContextualProductDetailsTool(session);

      logger.debug('sera', `Calling generateText with user message: "${safeUserMessage}"`);

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
      const toolResults = this.getToolResults(result);

      for (const toolResult of toolResults) {
        if (
          toolResult?.toolName === 'searchShopping' &&
          this.isSearchResultsPayload(toolResult.result)
        ) {
          searchResults = toolResult.result.results;
          session.lastSearchResults = searchResults;

          if (options.onSearchCompleted) {
            options.onSearchCompleted(searchResults);
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
        safeUserMessage.trim()
      );

      const response: SeraContinuationResult = {
        message: assistantMessage,
        completed,
      };

      if (searchResults) {
        response.searchResults = searchResults;
      }

      return response;
    } catch (error: unknown) {
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
      const enhancedGetProductDetails = this.searchAdapter.createContextualProductDetailsTool(session);

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
    } catch (error: unknown) {
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

  hydrateSession(conversation: SeraConversation): void {
    if (!conversation.sessionId) {
      throw new Error('Cannot hydrate Sera session without a sessionId');
    }

    const cloned = cloneSeraConversation(conversation);
    this.sessions.set(cloned.sessionId, cloned);
  }

  snapshotSession(sessionId: string): SeraConversation | undefined {
    const session = this.sessions.get(sessionId);
    return session ? cloneSeraConversation(session) : undefined;
  }

  releaseSession(sessionId: string): void {
    this.sessions.delete(sessionId);
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
   * Generate unique session ID
   */
  private generateSessionId(): string {
    return `sera_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  private getToolResults(result: unknown): ToolCallResult[] {
    if (!result || typeof result !== 'object') {
      return [];
    }

    const rawToolResults = (result as { toolResults?: unknown }).toolResults;
    if (!Array.isArray(rawToolResults)) {
      return [];
    }

    return rawToolResults.filter((entry): entry is ToolCallResult => {
      return typeof entry === 'object' && entry !== null;
    });
  }

  private isSearchResultsPayload(value: unknown): value is { results: SearchResult[] } {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const { results } = value as { results?: unknown };
    return Array.isArray(results);
  }
}
