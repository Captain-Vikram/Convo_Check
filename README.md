# Agent CLI Scaffold

TypeScript-based CLI scaffold for experimenting with multi-agent orchestration using the Vercel AI SDK.

## Prerequisites

- Node.js 20+
- npm 10+

## Setup

```bash
npm install
cp .env.example .env
# populate OPENAI_API_KEY in .env
```

## Commands

```bash
npm run dev        # Start the CLI in watch mode
npm run build      # Produce compiled output in dist/
npm run start      # Run the compiled CLI
npm run typecheck  # TypeScript typecheck without emit
npm run lint       # Lint source files

# Direct CLI usage
npm run build && node dist/index.js check
```

## Next Steps

- Add agent role definitions under `src/agents/`
- Wire providers and tools using the `ai` SDK
- Extend the CLI with subcommands for registering, invoking, and testing agents
