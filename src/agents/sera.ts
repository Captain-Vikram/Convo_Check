import { getAgentDescriptor } from "../config.js";
import type { AgentDefinition } from "./types.js";
import { SERA_SYSTEM_PROMPT } from "../runtime/sera/system-prompt.js";
import {
  searchShoppingToolDefinition,
  amazonProductLookupToolDefinition,
  addToWishlistToolDefinition,
  viewWishlistToolDefinition,
  getProductDetailsToolDefinition,
} from "../tools/sera.js";

const descriptor = getAgentDescriptor("agent5");

export const seraAgent: AgentDefinition = {
  ...descriptor,
  systemPrompt: SERA_SYSTEM_PROMPT,
  tools: [
    searchShoppingToolDefinition,
    amazonProductLookupToolDefinition,
    addToWishlistToolDefinition,
    viewWishlistToolDefinition,
    getProductDetailsToolDefinition,
  ],
};
