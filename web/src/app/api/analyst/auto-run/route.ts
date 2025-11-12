/**
 * API Route: Auto-Run Analyst Agent
 * 
 * POST /api/analyst/auto-run
 * 
 * Triggers the analyst agent to analyze new transactions.
 * Can be called by cron jobs, webhooks, or manual triggers.
 * 
 * Query Parameters:
 * - reanalyzeAll: "true" | "false" (default: false) - Force full reanalysis
 * - dryRun: "true" | "false" (default: false) - Check what would be analyzed
 * 
 * Authentication:
 * - Requires SERVICE_API_TOKEN in Authorization header
 * - Or DISABLE_AUTH=true environment variable (dev only)
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execAsync = promisify(exec);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes max execution time

function isAuthDisabled(): boolean {
  const flag = process.env.DISABLE_AUTH;
  return flag === "1" || (typeof flag === "string" && flag.toLowerCase() === "true");
}

function validateServiceToken(request: NextRequest): boolean {
  if (isAuthDisabled()) {
    return true;
  }

  const serviceToken = process.env.SERVICE_API_TOKEN;
  if (!serviceToken) {
    console.error("[analyst-api] SERVICE_API_TOKEN not configured");
    return false;
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }

  const token = authHeader.substring(7);
  return token === serviceToken;
}

export async function POST(request: NextRequest) {
  // Validate authentication
  if (!validateServiceToken(request)) {
    return NextResponse.json(
      { error: "Unauthorized. Valid SERVICE_API_TOKEN required." },
      { status: 401 },
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const reanalyzeAll = searchParams.get("reanalyzeAll") === "true";
  const dryRun = searchParams.get("dryRun") === "true";

  console.log("[analyst-api] Triggering analyst run", { reanalyzeAll, dryRun });

  try {
    // Build command to run analyst script
    const rootDir = join(process.cwd(), "..");
    const scriptPath = join(rootDir, "src", "runtime", "param", "analyst-agent.ts");
    
    let command = `npx tsx "${scriptPath}"`;
    if (reanalyzeAll) command += " --reanalyze-all";
    if (dryRun) command += " --dry-run";

    // Execute the analyst script
    const { stdout, stderr } = await execAsync(command, {
      cwd: rootDir,
      env: {
        ...process.env,
        SERVICE_API_TOKEN: process.env.SERVICE_API_TOKEN,
        DEV_USER_ID: process.env.DEV_USER_ID,
        DATABASE_URL: process.env.DATABASE_URL,
      },
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for output
    });

    // Parse the last JSON log line to get the result
    const logLines = stdout.split("\n").filter((line) => line.trim().startsWith("{"));
    const lastLog = logLines[logLines.length - 1];
    
    let result: any = {
      status: "success",
      message: "Analyst run completed",
      stdout: stdout.substring(stdout.length - 500), // Last 500 chars
    };

    if (lastLog) {
      try {
        const parsedLog = JSON.parse(lastLog);
        if (parsedLog.message) {
          result.message = parsedLog.message;
          result.meta = parsedLog.meta;
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    if (stderr) {
      console.warn("[analyst-api] stderr:", stderr);
      result.warnings = stderr;
    }

    console.log("[analyst-api] Analyst run completed successfully");

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (error: any) {
    console.error("[analyst-api] Analyst run failed", error);

    return NextResponse.json(
      {
        success: false,
        error: error?.message || String(error),
        stderr: error?.stderr,
        stdout: error?.stdout,
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  // Validate authentication
  if (!validateServiceToken(request)) {
    return NextResponse.json(
      { error: "Unauthorized. Valid SERVICE_API_TOKEN required." },
      { status: 401 },
    );
  }

  return NextResponse.json({
    message: "Analyst auto-run endpoint",
    usage: {
      method: "POST",
      queryParams: {
        reanalyzeAll: "true | false (default: false)",
        dryRun: "true | false (default: false)",
      },
      authentication: "Bearer <SERVICE_API_TOKEN>",
    },
    examples: [
      "POST /api/analyst/auto-run",
      "POST /api/analyst/auto-run?reanalyzeAll=true",
      "POST /api/analyst/auto-run?dryRun=true",
    ],
  });
}
