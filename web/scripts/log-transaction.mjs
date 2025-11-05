#!/usr/bin/env node

const [, , tokenArg] = process.argv;

const token = tokenArg ?? process.env.TEST_JWT_TOKEN;

if (!token) {
  console.error("Usage: node scripts/log-transaction.mjs <jwt-token>");
  process.exit(1);
}

const payload = {
  amount: 499.75,
  type: "debit",
  description: "Manual test logging",
  category: "testing",
  medium: "manual",
  targetParty: "QA Store",
  eventDate: new Date().toISOString(),
};

const response = await fetch("http://localhost:3000/api/transactions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

const text = await response.text();

console.log(`Status: ${response.status}`);
console.log(text);
