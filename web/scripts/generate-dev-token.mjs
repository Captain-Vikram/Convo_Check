#!/usr/bin/env node

import { SignJWT } from "jose";

const [, , userIdArg = "2", roleArg = "user", phoneArg = "", expiresArg = "7d"] = process.argv;

const userId = Number.parseInt(userIdArg, 10);

if (!Number.isFinite(userId)) {
  console.error("Usage: node scripts/generate-dev-token.mjs <userId> [role] [phone] [expires]");
  process.exit(1);
}

const secret = process.env.JWT_SECRET ?? "dev-secret-key";
const encoder = new TextEncoder();

const payload = {
  sub: String(userId),
  role: roleArg,
  ...(phoneArg ? { phone: phoneArg } : {}),
};

const expiresIn = expiresArg && expiresArg.trim().length > 0 ? expiresArg : "7d";

const token = await new SignJWT(payload)
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setIssuedAt()
  .setExpirationTime(expiresIn)
  .sign(encoder.encode(secret));

console.log(token);
if (process.argv[1]) {
  console.error(`Token expires in ${expiresIn}.`);
}
