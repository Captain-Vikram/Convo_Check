/**
 * Test Mill's Smart Query Handler with Intelligent Routing
 * 
 * Usage: node scripts/test-mill-query.js "your query here"
 * 
 * DATA QUERIES (Mill handles directly):
 *   node scripts/test-mill-query.js "what were my transactions yesterday?"
 *   node scripts/test-mill-query.js "show me last month's expenses"
 *   node scripts/test-mill-query.js "list all transactions this week"
 * 
 * COACHING QUERIES (Routes to Chatur):
 *   node scripts/test-mill-query.js "why am I spending so much?"
 *   node scripts/test-mill-query.js "how can I reduce my expenses?"
 *   node scripts/test-mill-query.js "give me advice on my spending habits"
 * 
 * MIXED QUERIES (Mill provides data, offers Chatur escalation):
 *   node scripts/test-mill-query.js "show my expenses and tell me if I'm overspending"
 *   node scripts/test-mill-query.js "what did I spend on food and is it too much?"
 */

import { processUserQuery } from "../dist/runtime/mill/integrated-query-handler.js";

const query = process.argv[2] || "what were my transactions yesterday?";

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`🤖 MILL - Smart Query Handler`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`\n🔍 User Query: "${query}"\n`);
console.log("⏳ Analyzing query and routing...\n");

try {
  const result = await processUserQuery(query, { showRouting: true });

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("� RESPONSE:");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log(result.response);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🔄 PROCESSING SUMMARY:");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Handled by Mill: ${result.handled ? "YES ✅" : "NO ❌"}`);
  console.log(`Target Agent: ${result.routing.targetAgent.toUpperCase()}`);
  console.log(`Data Type: ${result.routing.dataNeeded.type}`);
  console.log(`Escalation Needed: ${result.escalationNeeded ? "YES 🔄" : "NO"}`);

  if (result.escalationContext) {
    console.log(`\nEscalation Details:`);
    console.log(`  → Agent: ${result.escalationContext.agent.toUpperCase()}`);
    console.log(`  → Reason: ${result.escalationContext.reason}`);
  }

  console.log("\n✅ Query processing completed!");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
} catch (error) {
  console.error("\n❌ Error:", error.message);
  console.error(error);
  process.exit(1);
}
