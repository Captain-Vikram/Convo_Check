import type { SearchResult } from '@/tools/sera';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PendingWishlistAction {
  type: 'add';
  desiredPrice?: string;
  productUrl?: string;
  requestedAt: string;
}

export interface SeraConversation {
  sessionId: string;
  messages: ConversationMessage[];
  createdAt: string;
  lastSearchResults?: SearchResult[] | undefined;
  lastWishlistReference?: string | undefined;
  lastSavedWishlistItemId?: string | undefined;
  lastSavedWishlistItemName?: string | undefined;
  pendingWishlistAction?: PendingWishlistAction | undefined;
}

export interface WishlistItem {
  id: string;
  owner: number;
  name: string;
  link: string;
  currentPrice: string;
  desiredPrice: string;
  rating?: string | null | undefined;
  source: string;
  dateAdded?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
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
  if (typeof structuredClone === 'function') {
    return structuredClone(conversation);
  }

  return JSON.parse(JSON.stringify(conversation)) as SeraConversation;
}
