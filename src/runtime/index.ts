/**
 * Runtime Module - Multi-Agent Financial Tracking System
 * 
 * Organized by agent responsibility:
 * 
 * - mill/    : Mill Agent (Chatbot) - User interaction & transaction logging
 * - dev/     : Dev Agent (Gateway) - SMS processing & data storage
 * - param/   : Param Agent (Analyst) - Financial analysis & insights
 * - chatur/  : Chatur Agent (Coach) - Financial coaching & habits
 * - shared/  : Shared utilities - Communication, errors, data ops
 * 
 * Import from specific agent folders to avoid naming conflicts:
 * @example
 * import { createDevAgentEnvironment } from './runtime/dev';
 * import { ConversationalMill } from './runtime/mill';
 * import { AnalystAgent } from './runtime/param';
 * import { ConversationalCoach } from './runtime/chatur';
 * import { ConversationRouter, ErrorHandling } from './runtime/shared';
 */

// Use named exports to avoid conflicts - import from specific folders instead
export * as Mill from "./mill/index.js";
export * as Dev from "./dev/index.js";
export * as Param from "./param/index.js";
export * as Chatur from "./chatur/index.js";
export * as Shared from "./shared/index.js";
