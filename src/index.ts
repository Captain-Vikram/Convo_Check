#!/usr/bin/env node

import type { AgentId } from "./config.js";
import {
  assertRequiredEnvVars,
  getAgentConfig,
  listAgentDescriptors,
} from "./config.js";
import { getAgentDefinition } from "./agents/index.js";
import { runChatbotSession } from "./runtime/mill/chatbot-session.js";

const HELP_TEXT = `
Usage: agent-cli <command>

Commands:
  check                  Validate environment configuration
  chat                   Start an interactive session with Mill
  describe <agent>       Show agent metadata and system prompt
  help                   Show this help message
`;

function printHelp(): void {
  process.stdout.write(HELP_TEXT);
}

async function run(): Promise<void> {
  const [, , ...args] = process.argv;
  const [rawCommand, ...commandArgs] = args;
  const command = rawCommand ?? "help";

  switch (command) {
    case "check": {
      try {
        assertRequiredEnvVars();
        const agentSummaries = listAgentDescriptors().map(({ id, role, title, codename }) => {
          const { apiKey, model } = getAgentConfig(id);
          const persona = `${title} (${role}${codename ? ` – ${codename}` : ""})`;
          return `  ${id}: ${persona} | model=${model} | key=${maskSecret(apiKey)}`;
        });

        process.stdout.write("Environment looks good. Ready to bootstrap agents.\n");
        process.stdout.write("Configured agents:\n");
        process.stdout.write(`${agentSummaries.join("\n")}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      }
      break;
    }

    case "chat": {
      try {
        await runChatbotSession({ maxHistory: 20 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      }
      break;
    }

    case "describe": {
      const target = commandArgs[0];

      if (!target) {
        process.stderr.write("Please specify which agent to describe.\n");
        process.exitCode = 1;
        break;
      }

      const resolvedId = resolveAgentId(target);

      if (!resolvedId) {
        process.stderr.write(`Could not find an agent matching '${target}'.\n`);
        process.exitCode = 1;
        break;
      }

      try {
        const agent = getAgentDefinition(resolvedId);
        process.stdout.write(`Agent: ${agent.title} (${agent.id})\n`);
        process.stdout.write(`Role: ${agent.role}\n`);
        if (agent.codename) {
          process.stdout.write(`Codename: ${agent.codename}\n`);
        }
        process.stdout.write("\nSystem Prompt:\n");
        process.stdout.write(`${agent.systemPrompt}\n`);
        process.stdout.write("\nTools:\n");
        agent.tools.forEach((tool) => {
          process.stdout.write(`- ${tool.name}: ${tool.description}\n`);
          tool.parameters.forEach((param) => {
            const requirement = param.required ? "required" : "optional";
            process.stdout.write(`    - ${param.name} (${param.type}, ${requirement}) - ${param.description}\n`);
          });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      }
      break;
    }

    case "help":
    case "--help":
    case "-h":
    default: {
      printHelp();
      break;
    }
  }
}

run().catch((error) => {
  // Log unexpected failures before exiting so CLI users see actionable context.
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`Unexpected error: ${message}\n`);
  process.exitCode = 1;
});

function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function resolveAgentId(input: string): AgentId | undefined {
  const normalized = input.trim().toLowerCase();

  for (const descriptor of listAgentDescriptors()) {
    const candidates = [
      descriptor.id,
      descriptor.role,
      descriptor.title,
      descriptor.codename,
    ]
      .filter(Boolean)
      .map((candidate) => candidate.toLowerCase());

    if (candidates.includes(normalized)) {
      return descriptor.id;
    }

    const compactCodename = descriptor.codename.replace(/\s+/g, "").toLowerCase();
    if (compactCodename === normalized) {
      return descriptor.id;
    }
  }

  return undefined;
}
