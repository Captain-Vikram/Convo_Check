import { logger } from "../shared/logger.js";
import type { SearchResult } from "../../tools/sera.js";
import type { SeraConversation } from "./types.js";
import {
  addToWishlist,
  clearWishlist,
  getWishlist,
  removeWishlistItem,
  updateWishlistItem,
  type WishlistItem,
} from "./wishlist-manager.js";

export type WishlistCommand =
  | { type: "add"; reference?: string; desiredPrice?: string; productUrl?: string }
  | { type: "view" }
  | { type: "update"; reference?: string; desiredPrice?: string }
  | { type: "remove"; reference?: string }
  | { type: "clear" };

export interface WishlistControllerDependencies {
  findProductByReference(reference: string, results: SearchResult[]): SearchResult | null;
  createSearchResultFromUrl(url: string): Promise<SearchResult | null>;
}

const WISHLIST_PHRASE = "(?:wh?ish\\s*list)";

// Generic stop words for product name matching. These are neutral/common
// tokens that don't help identify a product (prepositions, short words,
// marketing terms). Session-specific stop words are derived dynamically
// from recent search results to avoid hard-coding domain-specific terms.
const GENERIC_STOP_WORDS = new Set([
  "with",
  "and",
  "for",
  "from",
  "the",
  "a",
  "an",
  "in",
  "on",
  "by",
  "new",
  "latest",
  "best",
  "top",
  "buy",
  "online",
  "cheap",
  "price",
  "model",
  "series",
  "color",
]);

export class WishlistController {
  constructor(private readonly deps: WishlistControllerDependencies) {}

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
      return { type: "clear" };
    }

    if (viewRegex.test(normalized)) {
      return { type: "view" };
    }

    if (addRegex.test(normalized)) {
      const command: WishlistCommand = { type: "add" };
      const referenceToken = this.extractReferenceToken(userMessage) ?? this.findReferenceByProductName(session, userMessage);
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
      const command: WishlistCommand = { type: "update" };
      const referenceToken = this.extractReferenceToken(userMessage) ?? this.findReferenceByProductName(session, userMessage);
      if (referenceToken) {
        command.reference = referenceToken;
      }
      if (desiredPrice) {
        command.desiredPrice = desiredPrice;
      }
      return command;
    }

    if (removeRegex.test(normalized)) {
      const command: WishlistCommand = { type: "remove" };
      const referenceToken = this.extractReferenceToken(userMessage) ?? this.findReferenceByProductName(session, userMessage);
      if (referenceToken) {
        command.reference = referenceToken;
      }
      return command;
    }

    if (
      desiredPrice &&
      session.lastSavedWishlistItemId &&
      this.isPriceFollowUpMessage(normalized)
    ) {
      return {
        type: "update",
        desiredPrice,
      };
    }

    const fallbackReference =
      this.extractReferenceToken(userMessage) ??
      this.findReferenceByProductName(session, userMessage);

    let pendingAction = session.pendingWishlistAction;
    if (pendingAction) {
      const requestedAtMs = new Date(pendingAction.requestedAt).getTime();
      const ageMs = Number.isFinite(requestedAtMs) ? Date.now() - requestedAtMs : 0;
      if (ageMs > 5 * 60 * 1000) {
        delete session.pendingWishlistAction;
        pendingAction = undefined;
      }
    }

    if (fallbackReference && pendingAction?.type === "add") {
      const deferredCommand: WishlistCommand = {
        type: "add",
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
      case "view": {
        const items = await getWishlist();
        return this.formatWishlistMessage(items);
      }
      case "update":
        return this.handleWishlistUpdate(session, command);
      case "remove":
        return this.handleWishlistRemoval(session, command);
      case "clear":
        return this.handleWishlistClear(session);
      case "add":
      default:
        return this.handleWishlistAdd(session, command);
    }
  }

  private async handleWishlistAdd(
    session: SeraConversation,
    command: Extract<WishlistCommand, { type: "add" }>
  ): Promise<string> {
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

    const reference = command.reference ?? session.lastWishlistReference ?? "#1";
    const product =
      (reference ? this.deps.findProductByReference(reference, lastResults) : null) ??
      lastResults[0];

    if (!product) {
      return "I couldn't find that product in the recent results. Try referencing it with '#1', 'first', or 'cheapest'.";
    }

    session.lastWishlistReference = reference;

    const desiredPrice = command.desiredPrice ?? product.price ?? "₹0";

    const wishlistItem: WishlistItem = {
      name: product.title,
      link: product.link,
      currentPrice: product.price ?? "₹0",
      desiredPrice,
      rating: product.rating,
      source: product.source ?? "Unknown store",
      dateAdded: new Date().toISOString().split("T")[0],
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
      logger.error("sera", "Wishlist save failed", error);
      return `I tried saving that product but hit an error: ${message}`;
    }
  }

  private async handleWishlistUpdate(
    session: SeraConversation,
    command: Extract<WishlistCommand, { type: "update" }>
  ): Promise<string> {
    const desiredPrice = command.desiredPrice;
    if (!desiredPrice) {
      return "Tell me the target price you want and which wishlist item to update.";
    }

    const wishlistItems = await getWishlist();
    if (!wishlistItems || wishlistItems.length === 0) {
      return "Your wishlist is empty right now. Add something first and then we can edit it.";
    }

    const targetItem =
      this.findWishlistItemByReference(command.reference, wishlistItems) ||
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
      logger.error("sera", "Wishlist update failed", error);
      return `I tried updating that wishlist item but hit an error: ${message}`;
    }
  }

  private async handleWishlistRemoval(
    session: SeraConversation,
    command: Extract<WishlistCommand, { type: "remove" }>
  ): Promise<string> {
    const wishlistItems = await getWishlist();
    if (!wishlistItems || wishlistItems.length === 0) {
      return "Your wishlist is already empty.";
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
        return "I tried removing that item but it may have already been deleted. Try showing your wishlist again.";
      }

      if (session.lastSavedWishlistItemId === targetItem.id) {
        session.lastSavedWishlistItemId = undefined;
        session.lastSavedWishlistItemName = undefined;
      }

      session.lastWishlistReference = undefined;

      return `🗑️ Removed "${targetItem.name}" from your wishlist.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("sera", "Wishlist removal failed", error);
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
        return "Your wishlist was already empty.";
      }

      const noun = deleted === 1 ? "item" : "items";
      return `🧹 Cleared ${deleted} ${noun} from your wishlist.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("sera", "Wishlist clear failed", error);
      return `I tried clearing your wishlist but hit an error: ${message}`;
    }
  }

  private formatWishlistMessage(items: WishlistItem[]): string {
    if (!items || items.length === 0) {
      return "📭 Your wishlist is empty right now. Ask me to add a product after we find something you like!";
    }

    const lines = ["💝 Here is your current wishlist:"];
    items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.name}`);
      lines.push(`   💵 Current: ${item.currentPrice} • 🎯 Target: ${item.desiredPrice}`);
      lines.push(`   🏪 ${item.source}${item.rating ? ` • ⭐ ${item.rating}` : ""}`);
      lines.push(`   🔗 ${item.link}`);
    });
    lines.push('Say "remove item #" or "clear wishlist" if you need to make changes.');
    return lines.join("\n");
  }

  private findWishlistItemByReference(
    reference: string | undefined,
    items: WishlistItem[]
  ): WishlistItem | undefined {
    if (!reference) {
      return undefined;
    }

    const ref = reference.toLowerCase().trim();
    if (items.length === 0) {
      return undefined;
    }

    if (ref === "last") {
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

    if (ref.includes("cheap") || ref.includes("lowest")) {
      return items.reduce((min, curr) => {
        const minPrice = this.extractNumericPrice(min.currentPrice);
        const currPrice = this.extractNumericPrice(curr.currentPrice);
        return currPrice < minPrice ? curr : min;
      });
    }

    if (ref.includes("expensive") || ref.includes("priciest")) {
      return items.reduce((max, curr) => {
        const maxPrice = this.extractNumericPrice(max.currentPrice);
        const currPrice = this.extractNumericPrice(curr.currentPrice);
        return currPrice > maxPrice ? curr : max;
      });
    }

    const normalizedRef = ref.replace(/[^a-z0-9]/g, " ").trim();
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
    // Default to conservative matching: break into tokens, strip
    // punctuation and short words, and remove generic + session-specific
    // stop words.
    const sessionStopWords = new Set(GENERIC_STOP_WORDS);
    // Note: we don't have the `session` here — callers will be updated to
    // pass a session-aware token set where available. Fall back to generic
    // stop words only.

    const tokens = title
      .split(/\s+/)
      .map((word) => word.replace(/[^a-z0-9]/gi, "").toLowerCase())
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
      first: "#1",
      second: "#2",
      third: "#3",
      fourth: "#4",
      fifth: "#5",
      last: "last",
    };
    for (const [word, ref] of Object.entries(wordNumbers)) {
      if (normalized.includes(word)) {
        return ref;
      }
    }

    const keywords = ["cheapest", "expensive", "priciest", "best rated", "top rated", "best", "top"];
    for (const keyword of keywords) {
      if (normalized.includes(keyword)) {
        return keyword;
      }
    }

    return undefined;
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

    return urlMatch[0].replace(/[),.;!?]+$/, "");
  }

  private normalizePriceInput(raw: string): string {
    const numericValue = Number.parseFloat(raw.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(numericValue)) {
      return raw.startsWith("₹") ? raw : `₹${raw}`;
    }

    return `₹${Math.round(numericValue).toLocaleString("en-IN")}`;
  }

  private extractNumericPrice(price: string | undefined): number {
    if (!price) {
      return Number.POSITIVE_INFINITY;
    }

    const numeric = Number.parseFloat(price.replace(/[^0-9.]/g, ""));
    return Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
  }
}
