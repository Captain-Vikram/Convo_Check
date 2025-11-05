import "dotenv/config";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FALLBACK_DB_URL = "postgres://user:password@host:5432/postgres";
const OUTPUT_PATH = join(process.cwd(), "data", "introspected-schema.prisma");

async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? FALLBACK_DB_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for introspection.");
  }

  const tempSchemaPath = join(tmpdir(), `prisma-introspect-${randomUUID()}.prisma`);
  const seedSchema = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`;

  await writeFile(tempSchemaPath, seedSchema, "utf8");

  await runPrismaDbPull(tempSchemaPath, databaseUrl);

  const schema = await readFile(tempSchemaPath, "utf8");
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(OUTPUT_PATH, schema, "utf8");

  console.log(`Database schema written to ${OUTPUT_PATH}`);

  await unlink(tempSchemaPath).catch(() => {
    // Temp file cleanup failure is non-critical.
  });
}

async function runPrismaDbPull(schemaPath: string, databaseUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const command = process.platform === "win32" ? "cmd.exe" : "npx";
    const args = process.platform === "win32"
      ? ["/c", "npx", "prisma", "db", "pull", "--schema", schemaPath]
      : ["prisma", "db", "pull", "--schema", schemaPath];

    const child = spawn(command, args, {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
      stdio: "inherit",
    });

    child.on("error", (error: Error) => {
      reject(error);
    });

    child.on("exit", (code: number | null) => {
      if (typeof code === "number" && code === 0) {
        resolve();
      } else {
        reject(new Error(`prisma db pull exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

run().catch((error) => {
  console.error("Failed to introspect database schema:", error);
  process.exitCode = 1;
});
