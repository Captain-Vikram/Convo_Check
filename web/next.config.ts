import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";

const rootEnvPath = join(process.cwd(), "..", ".env");

if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) {
  loadEnv({ path: rootEnvPath });
}

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
};

export default nextConfig;
