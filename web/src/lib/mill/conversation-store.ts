import { createClient, type RedisClientType } from "redis";

import {
  InMemoryConversationStore,
  type ConversationContext,
  type ConversationStore,
} from "../../../../src/runtime/shared/conversation-router";

const CONTEXT_TTL_SECONDS = 60 * 60; // 1 hour

class RedisConversationStore implements ConversationStore {
  private clientPromise: Promise<RedisClientType>;

  constructor(private readonly url: string) {
    this.clientPromise = this.initialize();
  }

  private async initialize(): Promise<RedisClientType> {
    const client = createClient({ url: this.url });
    client.on("error", (error) => {
      console.error("[conversation-store] Redis error", error);
    });
    await client.connect();
    return client;
  }

  private async getClient(): Promise<RedisClientType> {
    return this.clientPromise;
  }

  private key(userId: string): string {
    return `conversation:${userId}`;
  }

  async load(userId: string): Promise<ConversationContext | undefined> {
    const client = await this.getClient();
    const payload = await client.get(this.key(userId));
    if (!payload) {
      return undefined;
    }

    return JSON.parse(payload) as ConversationContext;
  }

  async save(userId: string, context: ConversationContext): Promise<void> {
    const client = await this.getClient();
    await client.set(this.key(userId), JSON.stringify(context), {
      EX: CONTEXT_TTL_SECONDS,
    });
  }

  async delete(userId: string): Promise<void> {
    const client = await this.getClient();
    await client.del(this.key(userId));
  }

  async cleanup(): Promise<void> {
    // TTL-based eviction handled by Redis automatically
  }
}

let cachedStore: ConversationStore | null = null;

function initializeStore(): ConversationStore {
  const redisUrl = process.env.REDIS_URL ?? process.env.UPSTASH_REDIS_URL;
  if (redisUrl) {
    return new RedisConversationStore(redisUrl);
  }

  console.warn(
    "[conversation-store] REDIS_URL not configured. Falling back to in-memory conversations. This is not stateless.",
  );
  return new InMemoryConversationStore();
}

export function getConversationStore(): ConversationStore {
  if (!cachedStore) {
    cachedStore = initializeStore();
  }

  return cachedStore;
}
