import type {
  ConversationContext,
  ConversationStore,
} from "@/runtime/shared/conversation-router";

// Stateless NO-OP conversation store.
// Session handling is performed by the ingress (wa-ingress). To avoid
// accidental Redis usage or persistence from this library, expose a
// no-op store that never loads or saves sessions.

const noopStore: ConversationStore = {
  async load(_userId: string) {
    return undefined;
  },
  async save(_userId: string, _context: ConversationContext) {
    // no-op
  },
  async delete(_userId: string) {
    // no-op
  },
  async cleanup(_maxAgeMs?: number) {
    // no-op
  },
};

export function getConversationStore(): ConversationStore {
  return noopStore;
}
