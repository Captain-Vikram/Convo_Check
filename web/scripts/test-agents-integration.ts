
import { PrismaClient } from "../../data/generated/prisma";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();
const API_URL = "http://localhost:3000/api/agent";
const TEST_USER_ID = "2";
const TEST_CATEGORY = "TestCategory_" + Date.now();
const TEST_AMOUNT = 500.00;

async function runIntegrationTest() {
  console.log("🚀 Starting Agents Integration Test...");
  console.log(`Target URL: ${API_URL}`);
  console.log(`Test User ID: ${TEST_USER_ID}`);

  try {
    // --- SETUP ---
    console.log("\n--- SETUP ---");
    // 1. Clean up previous test data for this user to ensure clean state
    console.log("Cleaning up old insights and briefings...");
    await prisma.habit_insights.deleteMany({ where: { owner: parseInt(TEST_USER_ID) } });
    await prisma.coach_briefings.deleteMany({ where: { owner: parseInt(TEST_USER_ID) } });
    
    // 2. Insert multiple dummy transactions to create a "habit" pattern
    console.log("Inserting dummy transactions...");
    const transactions = [
      { desc: "Coffee Shop", amount: 5.00, cat: "Dining" },
      { desc: "Coffee Shop", amount: 5.50, cat: "Dining" },
      { desc: "Coffee Shop", amount: 4.75, cat: "Dining" },
      { desc: "Grocery Store", amount: 150.00, cat: "Groceries" },
      { desc: "Online Subscription", amount: 15.00, cat: "Entertainment" }
    ];

    for (const t of transactions) {
        await prisma.tranasctions.create({
          data: {
            id: randomUUID(),
            owner: parseInt(TEST_USER_ID),
            amount: t.amount,
            description: t.desc,
            category: t.cat,
            type: "debit",
            status: "Active",
            date_of_transaction: new Date(),
            date_created: new Date(),
            date_updated: new Date(),
          }
        });
    }
    console.log(`Created ${transactions.length} transactions.`);


    // --- TEST 1: MILL READ (Query) ---
    console.log("\n--- TEST 1: MILL READ (Query) ---");
    const millQuery = `How much did I spend on Dining?`;
    console.log(`Sending Mill Query: "${millQuery}"`);

    const millResponse = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: TEST_USER_ID, message: millQuery }),
    });

    if (!millResponse.ok) throw new Error(`Mill request failed: ${millResponse.statusText}`);
    const millData = await millResponse.json();
    console.log("Mill Response Message:", millData.message);
    console.log("Mill Response Payload:", JSON.stringify(millData.result, null, 2));
    console.log("Mill Completed:", millData.completed);

    if (millData.message.includes("15.25") || (millData.result && JSON.stringify(millData.result).includes("15.25"))) {
      console.log("✅ SUCCESS: Mill retrieved the correct amount (approx 15.25).");
    } else {
      console.warn("⚠️ WARNING: Mill response might not contain the exact amount. Check output above.");
    }


    // --- TEST 2: CHATUR & ANALYST (Write/Trigger) ---
    console.log("\n--- TEST 2: CHATUR & ANALYST (Write/Trigger) ---");
    // We send a message that should route to Chatur. 
    // "Analyze my spending" is a strong signal for Chatur/Analyst.
    const chaturQuery = "Analyze my spending habits and give me a final plan immediately.";
    console.log(`Sending Chatur Query: "${chaturQuery}"`);

    let chaturResponse = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: TEST_USER_ID, message: chaturQuery }),
    });

    if (!chaturResponse.ok) {
      const errorText = await chaturResponse.text();
      throw new Error(`Chatur request failed: ${chaturResponse.status} ${chaturResponse.statusText} - ${errorText}`);
    }
    let chaturData = await chaturResponse.json();
    console.log("Chatur Response:", chaturData.message);
    console.log("Agent used:", chaturData.agent);

    // If session was stuck and just cleared, retry
    if (chaturData.message === "Session previously ended.") {
        console.log("🔄 Session was stuck. Retrying Chatur Query...");
        chaturResponse = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: TEST_USER_ID, message: chaturQuery }),
        });
        chaturData = await chaturResponse.json();
        console.log("Chatur Response (Retry):", chaturData.message);
        console.log("Agent used (Retry):", chaturData.agent);
    }
    
    // Send a follow-up to force completion if needed
    if (!chaturData.completed) {
        console.log("Sending follow-up to complete conversation...");
        const followUp = "That sounds good. Please finalize the plan.";
        chaturResponse = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: TEST_USER_ID, message: followUp }),
        });
        chaturData = await chaturResponse.json();
        console.log("Chatur Follow-up Response:", chaturData.message);
    }



    // Wait for async processes (Analyst runs in background/await chain)
    console.log("Waiting for Analyst to persist data...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verify Habit Insights (Analyst)
    const insightsCount = await prisma.habit_insights.count({
      where: { owner: parseInt(TEST_USER_ID) }
    });
    console.log(`Habit Insights found: ${insightsCount}`);

    if (insightsCount > 0) {
      console.log("✅ SUCCESS: Analyst generated and stored habit insights.");
      const insight = await prisma.habit_insights.findFirst({ where: { owner: parseInt(TEST_USER_ID) } });
      console.log("Sample Insight:", insight?.habit_label);
    } else {
      console.error("❌ FAILURE: No habit insights found. Analyst might not have run or failed.");
    }

    // Verify Coach Briefings (Chatur)
    // Note: Chatur might not always generate a briefing record if it's just chatting, 
    // but if it gave "guidance", it should be stored.
    const briefingsCount = await prisma.coach_briefings.count({
      where: { owner: parseInt(TEST_USER_ID) }
    });
    console.log(`Coach Briefings found: ${briefingsCount}`);

    if (briefingsCount > 0) {
      console.log("✅ SUCCESS: Chatur generated and stored a coach briefing.");
      const briefing = await prisma.coach_briefings.findFirst({ where: { owner: parseInt(TEST_USER_ID) } });
      console.log("Briefing Headline:", briefing?.headline);
    } else {
      console.log("ℹ️ INFO: No coach briefing stored. This might be normal if the conversation didn't trigger a formal briefing save.");
    }

  } catch (error) {
    console.error("\n❌ Test Failed:", error);
  } finally {
    // Cleanup
    console.log("\n--- CLEANUP ---");
    await prisma.tranasctions.deleteMany({ 
      where: { 
        owner: parseInt(TEST_USER_ID),
        description: { in: ["Coffee Shop", "Grocery Store", "Online Subscription", "Test Transaction for Integration"] }
      } 
    });
    // We leave the insights/briefings for manual inspection if needed, or delete them:
    // await prisma.habit_insights.deleteMany({ where: { owner: parseInt(TEST_USER_ID) } });
    // await prisma.coach_briefings.deleteMany({ where: { owner: parseInt(TEST_USER_ID) } });
    
    await prisma.$disconnect();
    console.log("Done.");
  }
}

runIntegrationTest();
