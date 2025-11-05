#!/usr/bin/env node

const [, , tokenArg] = process.argv;

const token = tokenArg ?? process.env.TEST_JWT_TOKEN;

if (!token) {
  console.error("Usage: node scripts/fetch-transactions.mjs <jwt-token>");
  process.exit(1);
}

const url = new URL("http://localhost:3000/api/transactions");
url.searchParams.set("limit", "5");

const response = await fetch(url, {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  },
});

const text = await response.text();

console.log(`Status: ${response.status}`);
console.log(text);
