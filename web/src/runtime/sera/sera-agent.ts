import { generateText, streamText, type LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { getAgentConfig } from '../../config';
import { logger } from '../shared/logger';
import { SERA_SYSTEM_PROMPT } from './system-prompt';
import {
  searchShoppingTool,
  amazonProductLookupTool,
  addToWishlistTool,
  viewWishlistTool,
  getProductDetailsTool,
  type SearchResult,
} from '@/tools/sera';
import {
  cloneSeraConversation,
  type SeraContinueOptions,
  type SeraConversation,
  type SeraContinuationResult,
  type SeraStartOptions,
  type WishlistItem,
} from './types';
import {
  addToWishlist,
  getWishlist,
  updateWishlistItem,
  removeWishlistItem,
  clearWishlist,
} from './wishlist-manager';
import {
  SearchResultPresenter,
  searchAmazonProduct,
  type AmazonSearchResult,
} from './services/search-service';
import { createFinancialCalculatorTool } from '@/tools/financial-calculator';

export type { SeraConversation } from './types';

type ToolCallResult = {
  toolName?: string;
  result?: unknown;
};

type WishlistCommand =
  | { type: 'view' }
  | { type: 'clear' }
  | { type: 'add'; reference?: string; desiredPrice?: string; productUrl?: string }
  | { type: 'update'; reference?: string; desiredPrice?: string }
  | { type: 'remove'; reference?: string };

type AddWishlistCommand = Extract<WishlistCommand, { type: 'add' }>;
type UpdateWishlistCommand = Extract<WishlistCommand, { type: 'update' }>;
type RemoveWishlistCommand = Extract<WishlistCommand, { type: 'remove' }>;

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
          financialCalculator: createFinancialCalculatorTool(),
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
          financialCalculator: createFinancialCalculatorTool(),
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

interface WishlistControllerDeps {
  findProductByReference(reference: string, results: SearchResult[]): SearchResult | null;
  createSearchResultFromUrl(productUrl: string): Promise<SearchResult | null>;
}

const WISHLIST_PHRASE = '(?:wh?ish\s*list)';
const GENERIC_STOP_WORDS = new Set([
  'with',
  'and',
  'for',
  'from',
  'the',
  'a',
  'an',
  'in',
  'on',
  'by',
  'new',
  'latest',
  'best',
  'top',
  'buy',
  'online',
  'cheap',
  'price',
  'model',
  'series',
  'color',
]);

class SeraSearchAdapter {
  createContextualProductDetailsTool(session: SeraConversation) {
    return {
      ...getProductDetailsTool,
      execute: async ({ productReference }: { productReference: string }) => {
        const results = session.lastSearchResults;
        if (!results || results.length === 0) {
          return {
            success: false,
            message: 'No recent search results available. Please search for products first.',
          };
        }

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
            price: product.price ?? 'N/A',
            priceNumeric: product.priceNumeric ?? null,
            rating: product.rating ?? 'N/A',
            source: product.source,
          },
        };
      },
    };
  }

  findProductByReference(reference: string, results: SearchResult[]): SearchResult | null {
    const ref = reference.toLowerCase().trim();
    const numberMatch = ref.match(/#?(\d+)/);
    if (numberMatch?.[1]) {
      const index = Number.parseInt(numberMatch[1], 10) - 1;
      return results[index] ?? null;
    }

    const wordNumbers: Record<string, number> = {
      first: 0,
      second: 1,
      third: 2,
      fourth: 3,
      fifth: 4,
      last: results.length - 1,
    };

    if (wordNumbers[ref] !== undefined) {
      return results[wordNumbers[ref]] ?? null;
    }

    if (ref.includes('cheap') || ref.includes('lowest price')) {
      return results.reduce((min, curr) => {
        const minPrice = min.price ? Number.parseFloat(min.price.replace(/[^0-9.]/g, '')) : Infinity;
        const currPrice = curr.price ? Number.parseFloat(curr.price.replace(/[^0-9.]/g, '')) : Infinity;
        return currPrice < minPrice ? curr : min;
      });
    }

    if (ref.includes('expensive') || ref.includes('priciest')) {
      return results.reduce((max, curr) => {
        const maxPrice = max.price ? Number.parseFloat(max.price.replace(/[^0-9.]/g, '')) : 0;
        const currPrice = curr.price ? Number.parseFloat(curr.price.replace(/[^0-9.]/g, '')) : 0;
        return currPrice > maxPrice ? curr : max;
      });
    }

    if (ref.includes('best rated') || ref.includes('highest rated') || ref.includes('top rated')) {
      return results.reduce((max, curr) => {
        const maxRating = max.rating ? Number.parseFloat(max.rating) : 0;
        const currRating = curr.rating ? Number.parseFloat(curr.rating) : 0;
        return currRating > maxRating ? curr : max;
      });
    }

    const storeMatch = ref.match(/(amazon|flipkart|croma|myntra|ajio)/i);
    if (storeMatch?.[1]) {
      const store = storeMatch[1];
      return results.find((result) => result.source?.toLowerCase().includes(store.toLowerCase())) ?? null;
    }

    return null;
  }

  extractAmazonUrl(message: string): string | undefined {
    const urlMatch = message.match(/https?:\/\/[^^\s]*amazon\.[^\s]+/i);
    if (!urlMatch?.[0]) {
      return undefined;
    }
    return urlMatch[0].replace(/[),.;!?]+$/, '');
  }

  async handleAmazonLinkRequest(session: SeraConversation, amazonUrl: string): Promise<{
    message: string;
    searchResults?: SearchResult[];
  }> {
    let amazonResults: AmazonSearchResult[] = [];
    let derivedSource: string | undefined = amazonUrl;

    try {
      const lookup = await searchAmazonProduct(amazonUrl);
      amazonResults = lookup.results;
      if (lookup.query) {
        derivedSource = lookup.query;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('sera', `Amazon lookup failed; falling back to URL parsing: ${message}`);
    }

    if (!amazonResults || amazonResults.length === 0) {
      try {
        const fallbackResult = await this.createSearchResultFromUrl(amazonUrl);
        if (!fallbackResult) {
          return {
            message:
              "I tried to parse that Amazon link but couldn't extract the product details yet. Could you describe the item so I can search manually?",
          };
        }

        session.lastSearchResults = [fallbackResult];
        const formatted = SearchResultPresenter.formatResultsTable([fallbackResult]);
        return {
          message: [
            "Here's the listing I could pull directly from Amazon:",
            formatted,
            'Let me know if you want me to compare it with other stores afterward.',
          ].join('\n\n'),
          searchResults: session.lastSearchResults,
        };
      } catch (fallbackError) {
        const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        logger.error('sera', 'Amazon parsing failed', fallbackError);
        return {
          message: `I tried to inspect that Amazon link but hit an error: ${message}. Want to describe the product instead?`,
        };
      }
    }

    const normalizedResults = SearchResultPresenter.mapAmazonResults(amazonResults.slice(0, 5));
    session.lastSearchResults = normalizedResults;
    const formatted = SearchResultPresenter.formatResultsTable(normalizedResults);
    const headline = amazonResults[0]?.title ?? derivedSource ?? 'this Amazon product';

    return {
      message: [
        `Here are the closest matches I pulled straight from Amazon for "${headline}":`,
        formatted,
        'Pick a number to save it, or say "compare" if you want me to check other retailers after this.',
      ].join('\n\n'),
      searchResults: normalizedResults,
    };
  }

  async createSearchResultFromUrl(productUrl: string): Promise<SearchResult | null> {
    if (!productUrl) {
      return null;
    }

    try {
      if (/amazon\./i.test(productUrl)) {
        const { results } = await searchAmazonProduct(productUrl);
        const product = results[0];
        if (!product) {
          return null;
        }

        const mapped: SearchResult = {
          title: product.title,
          source: 'Amazon.in',
          link: product.link || productUrl,
        };

        if (product.price) mapped.price = product.price;
        if (product.priceNumeric !== undefined) mapped.priceNumeric = product.priceNumeric;
        if (product.rating) mapped.rating = product.rating;
        if (product.ratingNumeric !== undefined) mapped.ratingNumeric = product.ratingNumeric;
        if (product.reviews) mapped.reviews = product.reviews;
        if (product.reviewCount !== undefined) mapped.reviewCount = product.reviewCount;
        if (product.delivery) mapped.delivery = product.delivery;
        if (product.thumbnail) mapped.thumbnail = product.thumbnail;

        return mapped;
      }
    } catch (error) {
      logger.error('sera', 'Direct product fetch failed', error);
    }

    return null;
  }
}

class WishlistController {
  constructor(private readonly deps: WishlistControllerDeps) {}

  detectCommand(session: SeraConversation, userMessage: string): WishlistCommand | null {
    const normalized = userMessage.toLowerCase();
    const productUrl = this.extractProductUrl(userMessage);
    const desiredPrice = this.extractDesiredPrice(userMessage);

    const viewRegex = new RegExp(`\\b(show|view|see|display)\\b.*${WISHLIST_PHRASE}`);
    const clearRegex = new RegExp(`\\b(clear|empty|reset)\\b.*${WISHLIST_PHRASE}`);
    const addRegex = new RegExp(`(add|save|put|store).*(?:${WISHLIST_PHRASE})`);
    const updateRegex = new RegExp(`(update|change|edit|adjust|set).*(?:${WISHLIST_PHRASE}|target|price)`);
    const removeRegex = new RegExp(`(remove|delete|drop|forget|erase).*(?:${WISHLIST_PHRASE}|it|item)`);

    if (clearRegex.test(normalized)) {
      return { type: 'clear' };
    }

    if (viewRegex.test(normalized)) {
      return { type: 'view' };
    }

    if (addRegex.test(normalized)) {
      const command: WishlistCommand = { type: 'add' };
      const referenceToken =
        this.extractReferenceToken(userMessage) ?? this.findReferenceByProductName(session, userMessage);
      if (referenceToken) {
        command.reference = referenceToken;
      }
      if (desiredPrice) {
        command.desiredPrice = desiredPrice;
      }
      if (productUrl) {
        command.productUrl = productUrl;
      }
      return command;
    }

    if (updateRegex.test(normalized)) {
      const command: WishlistCommand = { type: 'update' };
      const referenceToken =
        this.extractReferenceToken(userMessage) ?? this.findReferenceByProductName(session, userMessage);
      if (referenceToken) {
        command.reference = referenceToken;
      }
      if (desiredPrice) {
        command.desiredPrice = desiredPrice;
      }
      return command;
    }

    if (removeRegex.test(normalized)) {
      const command: WishlistCommand = { type: 'remove' };
      const referenceToken =
        this.extractReferenceToken(userMessage) ?? this.findReferenceByProductName(session, userMessage);
      if (referenceToken) {
        command.reference = referenceToken;
      }
      return command;
    }

    if (desiredPrice && session.lastSavedWishlistItemId && this.isPriceFollowUpMessage(normalized)) {
      return {
        type: 'update',
        desiredPrice,
      };
    }

    const fallbackReference =
      this.extractReferenceToken(userMessage) ?? this.findReferenceByProductName(session, userMessage);

    let pendingAction = session.pendingWishlistAction;
    if (pendingAction) {
      const requestedAtMs = new Date(pendingAction.requestedAt).getTime();
      const ageMs = Number.isFinite(requestedAtMs) ? Date.now() - requestedAtMs : 0;
      if (ageMs > 5 * 60 * 1000) {
        delete session.pendingWishlistAction;
        pendingAction = undefined;
      }
    }

    if (fallbackReference && pendingAction?.type === 'add') {
      const deferredCommand: WishlistCommand = {
        type: 'add',
        reference: fallbackReference,
      };
      if (pendingAction.desiredPrice) {
        deferredCommand.desiredPrice = pendingAction.desiredPrice;
      }
      if (pendingAction.productUrl) {
        deferredCommand.productUrl = pendingAction.productUrl;
      }
      return deferredCommand;
    }

    return null;
  }

  captureReferenceFromMessage(session: SeraConversation, message: string): void {
    const reference = this.extractReferenceToken(message);
    if (reference) {
      session.lastWishlistReference = reference;
      return;
    }

    const inferred = this.findReferenceByProductName(session, message);
    if (inferred) {
      session.lastWishlistReference = inferred;
    }
  }

  async handleCommand(session: SeraConversation, command: WishlistCommand): Promise<string> {
    switch (command.type) {
      case 'view': {
        const items = await getWishlist();
        return this.formatWishlistMessage(items);
      }
      case 'update':
        return this.handleWishlistUpdate(session, command);
      case 'remove':
        return this.handleWishlistRemoval(session, command);
      case 'clear':
        return this.handleWishlistClear(session);
      case 'add':
      default:
        return this.handleWishlistAdd(session, command);
    }
  }

  private async handleWishlistAdd(session: SeraConversation, command: AddWishlistCommand): Promise<string> {
    delete session.pendingWishlistAction;
    let lastResults = session.lastSearchResults;

    if ((!lastResults || lastResults.length === 0) && command.productUrl) {
      const fetched = await this.deps.createSearchResultFromUrl(command.productUrl);
      if (fetched) {
        session.lastSearchResults = [fetched];
        lastResults = session.lastSearchResults;
      }
    }

    if (!lastResults || lastResults.length === 0) {
      return "I don't have any recent products to save. Ask me to search first, then pick the one you'd like me to remember.";
    }

    const reference = command.reference ?? session.lastWishlistReference ?? '#1';
    const product = (reference ? this.deps.findProductByReference(reference, lastResults) : null) ?? lastResults[0];

    if (!product) {
      return "I couldn't find that product in the recent results. Try referencing it with '#1', 'first', or 'cheapest'.";
    }

    session.lastWishlistReference = reference;
    const desiredPrice = command.desiredPrice ?? product.price ?? '₹0';

    const wishlistItem = {
      name: product.title,
      link: product.link,
      currentPrice: product.price ?? '₹0',
      desiredPrice,
      rating: product.rating,
      source: product.source ?? 'Unknown store',
      dateAdded: new Date().toISOString().split('T')[0],
    };

    try {
      const saved = await addToWishlist(wishlistItem);
      if (saved.id) {
        session.lastSavedWishlistItemId = saved.id;
      }
      session.lastSavedWishlistItemName = saved.name;
      return `💝 Added "${saved.name}" (${wishlistItem.currentPrice}) from ${wishlistItem.source} to your wishlist. Say "show wishlist" anytime to review saved items!`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('sera', 'Wishlist save failed', error);
      return `I tried saving that product but hit an error: ${message}`;
    }
  }

  private async handleWishlistUpdate(session: SeraConversation, command: UpdateWishlistCommand): Promise<string> {
    const desiredPrice = command.desiredPrice;
    if (!desiredPrice) {
      return 'Tell me the target price you want and which wishlist item to update.';
    }

    const wishlistItems = await getWishlist();
    if (!wishlistItems || wishlistItems.length === 0) {
      return 'Your wishlist is empty right now. Add something first and then we can edit it.';
    }

    const targetItem =
      this.findWishlistItemByReference(command.reference, wishlistItems) ??
      (session.lastSavedWishlistItemId
        ? wishlistItems.find((item) => item.id === session.lastSavedWishlistItemId)
        : undefined);

    if (!targetItem || !targetItem.id) {
      return "I couldn't figure out which wishlist item to edit. Try saying something like 'update wishlist #1 to ₹15,000'.";
    }

    const normalizedPrice = desiredPrice || targetItem.desiredPrice || targetItem.currentPrice;

    try {
      const updated = await updateWishlistItem(targetItem.id, {
        desiredPrice: normalizedPrice,
      });
      if (updated.id) {
        session.lastSavedWishlistItemId = updated.id;
      }
      session.lastSavedWishlistItemName = updated.name;
      return `✏️ Updated "${updated.name}" — new target price is ${normalizedPrice}.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('sera', 'Wishlist update failed', error);
      return `I tried updating that wishlist item but hit an error: ${message}`;
    }
  }

  private async handleWishlistRemoval(session: SeraConversation, command: RemoveWishlistCommand): Promise<string> {
    const wishlistItems = await getWishlist();
    if (!wishlistItems || wishlistItems.length === 0) {
      return 'Your wishlist is already empty.';
    }

    const reference = command.reference ?? session.lastWishlistReference;
    let targetItem = this.findWishlistItemByReference(reference, wishlistItems);
    if (!targetItem && session.lastSavedWishlistItemId) {
      targetItem = wishlistItems.find((item) => item.id === session.lastSavedWishlistItemId);
    }
    if (!targetItem && wishlistItems.length === 1) {
      targetItem = wishlistItems[0];
    }

    if (!targetItem || !targetItem.id) {
      return "I couldn't figure out which wishlist item to remove. Try saying something like 'remove wishlist #1'.";
    }

    try {
      const removed = await removeWishlistItem(targetItem.id);
      if (!removed) {
        return 'I tried removing that item but it may have already been deleted. Try showing your wishlist again.';
      }

      if (session.lastSavedWishlistItemId === targetItem.id) {
        session.lastSavedWishlistItemId = undefined;
        session.lastSavedWishlistItemName = undefined;
      }
      session.lastWishlistReference = undefined;
      return `🗑️ Removed "${targetItem.name}" from your wishlist.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('sera', 'Wishlist removal failed', error);
      return `I tried removing that wishlist item but hit an error: ${message}`;
    }
  }

  private async handleWishlistClear(session: SeraConversation): Promise<string> {
    try {
      const deleted = await clearWishlist();
      session.lastSavedWishlistItemId = undefined;
      session.lastSavedWishlistItemName = undefined;
      session.lastWishlistReference = undefined;

      if (deleted === 0) {
        return 'Your wishlist was already empty.';
      }

      const noun = deleted === 1 ? 'item' : 'items';
      return `🧹 Cleared ${deleted} ${noun} from your wishlist.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('sera', 'Wishlist clear failed', error);
      return `I tried clearing your wishlist but hit an error: ${message}`;
    }
  }

  private formatWishlistMessage(items: WishlistItem[]): string {
    if (!items || items.length === 0) {
      return '📭 Your wishlist is empty right now. Ask me to add a product after we find something you like!';
    }

    const lines: string[] = ['💝 Here is your current wishlist:'];
    items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.name}`);
      lines.push(`   💵 Current: ${item.currentPrice} • 🎯 Target: ${item.desiredPrice}`);
      lines.push(`   🏪 ${item.source}${item.rating ? ` • ⭐ ${item.rating}` : ''}`);
      lines.push(`   🔗 ${item.link}`);
    });
    lines.push('Say "remove item #" or "clear wishlist" if you need to make changes.');
    return lines.join('\n');
  }

  private findWishlistItemByReference(reference: string | undefined, items: WishlistItem[]): WishlistItem | undefined {
    if (!reference) {
      return undefined;
    }

    const ref = reference.toLowerCase().trim();
    if (items.length === 0) {
      return undefined;
    }

    if (ref === 'last') {
      return items[items.length - 1];
    }

    const numberMatch = ref.match(/#?(\d+)/);
    if (numberMatch?.[1]) {
      const index = Number.parseInt(numberMatch[1], 10) - 1;
      if (index >= 0 && index < items.length) {
        return items[index];
      }
    }

    const wordNumbers: Record<string, number> = {
      first: 0,
      second: 1,
      third: 2,
      fourth: 3,
      fifth: 4,
    };

    if (wordNumbers[ref] !== undefined) {
      return items[wordNumbers[ref]];
    }

    if (ref.includes('cheap') || ref.includes('lowest')) {
      return items.reduce((min, curr) => {
        const minPrice = this.extractNumericPrice(min.currentPrice);
        const currPrice = this.extractNumericPrice(curr.currentPrice);
        return currPrice < minPrice ? curr : min;
      });
    }

    if (ref.includes('expensive') || ref.includes('priciest')) {
      return items.reduce((max, curr) => {
        const maxPrice = this.extractNumericPrice(max.currentPrice);
        const currPrice = this.extractNumericPrice(curr.currentPrice);
        return currPrice > maxPrice ? curr : max;
      });
    }

    const normalizedRef = ref.replace(/[^a-z0-9]/g, ' ').trim();
    if (normalizedRef.length >= 3) {
      return items.find((item) => item.name.toLowerCase().includes(normalizedRef));
    }

    return undefined;
  }

  private findReferenceByProductName(session: SeraConversation, message: string): string | undefined {
    if (!session.lastSearchResults || session.lastSearchResults.length === 0) {
      return undefined;
    }

    const normalizedMessage = message.toLowerCase();
    const matches = session.lastSearchResults
      .map((product, index) => ({ product, index }))
      .filter(({ product }) => this.productNameMatches(normalizedMessage, product.title.toLowerCase()));

    if (matches.length === 1) {
      const match = matches[0];
      if (match) {
        return `#${match.index + 1}`;
      }
    }

    return undefined;
  }

  private productNameMatches(message: string, title: string): boolean {
    const sessionStopWords = new Set(GENERIC_STOP_WORDS);
    const tokens = title
      .split(/\s+/)
      .map((word) => word.replace(/[^a-z0-9]/gi, '').toLowerCase())
      .filter((word) => word.length > 3 && !sessionStopWords.has(word));

    let hits = 0;
    for (const token of tokens) {
      if (token && message.includes(token)) {
        hits += 1;
        if (hits >= 2) {
          return true;
        }
      }
    }
    return false;
  }

  private extractReferenceToken(message: string): string | undefined {
    const normalized = message.toLowerCase();
    const hashMatch = normalized.match(/#(\d+)/);
    if (hashMatch?.[1]) {
      return `#${hashMatch[1]}`;
    }

    const ordinalMatch = normalized.match(/\b(\d+)(?:st|nd|rd|th)\b/);
    if (ordinalMatch?.[1]) {
      return `#${ordinalMatch[1]}`;
    }

    const wordNumbers: Record<string, string> = {
      first: '#1',
      second: '#2',
      third: '#3',
      fourth: '#4',
      fifth: '#5',
      last: 'last',
    };

    for (const [word, ref] of Object.entries(wordNumbers)) {
      if (normalized.includes(word)) {
        return ref;
      }
    }

    const keywords = ['cheapest', 'expensive', 'priciest', 'best rated', 'top rated', 'best', 'top'];
    for (const keyword of keywords) {
      if (normalized.includes(keyword)) {
        return keyword;
      }
    }

    return undefined;
  }

  private extractDesiredPrice(message: string): string | undefined {
    const rupeeMatch = message.match(/₹[\d,.]+/i);
    if (rupeeMatch?.[0]) {
      return this.normalizePriceInput(rupeeMatch[0]);
    }

    const numberMatch = message.match(/\b\d{3,6}(?:\.\d+)?\b/);
    if (numberMatch?.[0]) {
      return this.normalizePriceInput(numberMatch[0]);
    }

    return undefined;
  }

  private extractProductUrl(message: string): string | undefined {
    const urlMatch = message.match(/https?:\/\/[^\s]+/i);
    if (!urlMatch?.[0]) {
      return undefined;
    }
    return urlMatch[0].replace(/[),.;!?]+$/, '');
  }

  private normalizePriceInput(raw: string): string {
    const numericValue = Number.parseFloat(raw.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(numericValue)) {
      return raw.startsWith('₹') ? raw : `₹${raw}`;
    }
    return `₹${Math.round(numericValue).toLocaleString('en-IN')}`;
  }

  private extractNumericPrice(price: string | undefined): number {
    if (!price) {
      return Number.POSITIVE_INFINITY;
    }
    const numeric = Number.parseFloat(price.replace(/[^0-9.]/g, ''));
    return Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
  }

  private isPriceFollowUpMessage(normalizedMessage: string): boolean {
    return (
      /\baround\b/.test(normalizedMessage) ||
      /\babout\b/.test(normalizedMessage) ||
      /\bmake it\b/.test(normalizedMessage) ||
      /\bset it\b/.test(normalizedMessage) ||
      /\bkeep it\b/.test(normalizedMessage) ||
      /\btarget\b/.test(normalizedMessage) ||
      /\bprice\b/.test(normalizedMessage)
    );
  }
}
