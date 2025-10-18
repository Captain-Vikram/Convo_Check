/**
 * Test Mill's Natural Chat Interface
 * 
 * This demonstrates the user-friendly conversational interface.
 * 
 * Usage: node scripts/test-mill-chat.js "your question here"
 */

import { chatQuery } from "../dist/runtime/mill/natural-query-handler.js";

const userMessage = process.argv[2] || "show me my transactions from last month";

console.log(`\n💬 You: ${userMessage}\n`);
console.log("🤖 Mill is thinking...\n");

try {
  const response = await chatQuery(userMessage);
  
  console.log(`🤖 Mill: ${response}\n`);
  
} catch (error) {
  console.error("❌ Error:", error.message);
  process.exit(1);
}
