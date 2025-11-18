import { getAgentDescriptor } from "../config";
import type { AgentDefinition } from "./types";
import { SERA_SYSTEM_PROMPT } from "../runtime/sera/system-prompt";
import {
  addToWishlistTool,
  viewWishlistTool,
  searchShoppingTool,
  amazonProductLookupTool,
  getProductDetailsTool,
} from "../tools/sera";

const descriptor = getAgentDescriptor("agent5");

export const seraAgent: AgentDefinition = {
  ...descriptor,
  systemPrompt: SERA_SYSTEM_PROMPT,
  tools: [
    addToWishlistTool,
    viewWishlistTool,
    searchShoppingTool,
    amazonProductLookupTool,
    getProductDetailsTool,
  ],
};
