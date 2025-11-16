import type { SearchResult } from "../../tools/sera.js";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PendingWishlistAction {
  type: "add";
  desiredPrice?: string;
  productUrl?: string;
  requestedAt: string;
}

export interface SeraConversation {
  sessionId: string;
  messages: ConversationMessage[];
  lastSearchResults?: SearchResult[];
  lastWishlistReference?: string | undefined;
  lastSavedWishlistItemId?: string | undefined;
  lastSavedWishlistItemName?: string | undefined;
  pendingWishlistAction?: PendingWishlistAction;
  createdAt: string;
}

export interface SeraStartOptions {
  initialGreeting?: string;
  suppressGreeting?: boolean;
}

export interface SeraContinueOptions {
  onSearchCompleted?: (results: SearchResult[]) => void;
}

export interface SeraContinuationResult {
  message: string;
  completed: boolean;
  searchResults?: SearchResult[];
}

export function cloneSeraConversation(conversation: SeraConversation): SeraConversation {
  if (typeof structuredClone === "function") {
    return structuredClone(conversation);
  }

  return JSON.parse(JSON.stringify(conversation)) as SeraConversation;
}
