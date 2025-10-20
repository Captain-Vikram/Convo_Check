# AWS Bedrock Migration Guide

**Status**: ✅ **Migration Complete** - Ready for testing after `npm install` and environment configuration.

---

## Summary

Successfully migrated from Google Gemini to AWS Bedrock using Vercel AI SDK's native `@ai-sdk/amazon-bedrock` provider. The migration was straightforward because Vercel AI SDK provides first-class Bedrock support with minimal API differences.

### What Changed

- **Provider**: Google Gemini → AWS Bedrock
- **Default Model**: `gemini-2.0-pro-exp` → `anthropic.claude-3-5-sonnet-20241022-v2:0`
- **Package Added**: `@ai-sdk/amazon-bedrock@^2.1.4`
- **Files Modified**: 13 files (config + 12 agent runtime files)
- **Complexity**: ⭐ Low - Simple provider swap, no custom adapters needed

---

## Quick Start

### 1. Install Dependencies

```powershell
npm install
```

### 2. Configure Environment

Create/update `.env`:

```env
# Required: Provider selection
AI_PROVIDER=bedrock

# Required: AWS Credentials
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-1

# Optional: Default model (can be overridden per agent)
AI_MODEL=anthropic.claude-3-5-sonnet-20241022-v2:0

# Optional: Per-agent model overrides
CHATBOT_MODEL=anthropic.claude-3-5-sonnet-20241022-v2:0
ACCOUNTANT_MODEL=anthropic.claude-3-5-haiku-20241022-v1:0
ANALYST_MODEL=anthropic.claude-3-5-sonnet-20241022-v2:0
COACH_MODEL=anthropic.claude-3-5-sonnet-20241022-v2:0
```

**To switch back to Google**: Set `AI_PROVIDER=google` and provide Gemini API keys.

### 3. Request Bedrock Model Access

AWS Bedrock requires explicit model access approval:

1. Open [AWS Bedrock Console](https://console.aws.amazon.com/bedrock/)
2. Go to "Model access" → "Manage model access"
3. Enable Anthropic Claude models
4. Submit (usually instant approval)

See [AWS Docs](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html).

### 4. Test

```powershell
npm run dev
# or
npm run analyst
```

---

## Recommended Models

Based on your system's usage patterns (JSON generation, tool calling, conversational responses):

### Primary Recommendation: Anthropic Claude

**Best for production:**

- `anthropic.claude-3-5-sonnet-20241022-v2:0` (or `us.anthropic.claude-3-5-sonnet-20241022-v2:0`)
  - **Use for**: Agent orchestrator, analyst, coach, chatbot
  - **Why**: Excellent JSON generation, reliable tool calling, strong reasoning
  - **Cost**: Mid-tier (~$3/M input, $15/M output tokens)

**Faster/cheaper alternative:**

- `anthropic.claude-3-5-haiku-20241022-v1:0`
  - **Use for**: Dev agent (transaction parsing), quick queries
  - **Why**: 3x faster, 4x cheaper, still reliable for structured tasks
  - **Cost**: Low (~$1/M input, $5/M output tokens)

### Alternative: Amazon Nova (AWS-native)

- `us.amazon.nova-pro-v1:0` - Good balance, multimodal support
- `us.amazon.nova-lite-v1:0` - Fast and cheap for simple tasks

**Not recommended**: Llama/Mistral models for this codebase (weaker JSON reliability).

---

## Technical Details

### Changes Made

#### 1. Package.json

- Added `@ai-sdk/amazon-bedrock@^2.1.4`
- Kept `@ai-sdk/google` for fallback/testing

#### 2. Config (src/config.ts)

```typescript
// Added provider detection
export function getProvider(): "bedrock" | "google" {
  const provider = process.env.AI_PROVIDER?.toLowerCase();
  return provider === "google" ? "google" : "bedrock"; // Defaults to Bedrock
}

// Updated AgentRuntimeConfig
export interface AgentRuntimeConfig {
  // ... existing fields
  provider: "bedrock" | "google";
  awsRegion?: string;
}
```

#### 3. All Agent Files (12 files)

Pattern used in each file:

**Before**:

```typescript
import { createGoogleGenerativeAI } from "@ai-sdk/google";

const { apiKey, model } = getAgentConfig("agent1");
const provider = createGoogleGenerativeAI({ apiKey });
const languageModel = provider(model);
```

**After**:

```typescript
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

const config = getAgentConfig("agent1");
const { provider, apiKey, model, awsRegion } = config;

const languageModel =
  provider === "bedrock"
    ? createAmazonBedrock({
        region: awsRegion || process.env.AWS_REGION || "us-east-1",
      })(model)
    : createGoogleGenerativeAI({ apiKey })(model);
```

**Files Updated**:

- `src/runtime/shared/agent-orchestrator.ts`
- `src/runtime/mill/chatbot-session.ts`
- `src/runtime/mill/conversational-mill.ts`
- `src/runtime/mill/natural-query-handler.ts`
- `src/runtime/mill/query-router.ts`
- `src/runtime/mill/transaction-query-handler.ts`
- `src/runtime/param/analyst-agent.ts`
- `src/runtime/param/habit-tracker.ts`
- `src/runtime/dev/dev-llm-parser.ts`
- `src/runtime/chatur/chatur-coordinator.ts`
- `src/runtime/chatur/coach-agent.ts`
- `src/runtime/chatur/conversational-coach.ts`

---

## Environment Variables Reference

### Required for Bedrock

| Variable                | Description        | Example                     |
| ----------------------- | ------------------ | --------------------------- |
| `AI_PROVIDER`           | Provider selection | `bedrock` or `google`       |
| `AWS_ACCESS_KEY_ID`     | AWS IAM access key | `AKIAIOSFODNN7EXAMPLE`      |
| `AWS_SECRET_ACCESS_KEY` | AWS IAM secret key | `wJalrXUtnFEMI/K7MDENG/...` |
| `AWS_REGION`            | AWS region         | `us-east-1`                 |

### Optional Model Configuration

| Variable           | Description                    | Default                                     |
| ------------------ | ------------------------------ | ------------------------------------------- |
| `AI_MODEL`         | Global default model           | `anthropic.claude-3-5-sonnet-20241022-v2:0` |
| `CHATBOT_MODEL`    | Mill (agent1) model override   | Inherits `AI_MODEL`                         |
| `ACCOUNTANT_MODEL` | Dev (agent2) model override    | Inherits `AI_MODEL`                         |
| `ANALYST_MODEL`    | Param (agent3) model override  | Inherits `AI_MODEL`                         |
| `COACH_MODEL`      | Chatur (agent4) model override | Inherits `AI_MODEL`                         |

### Legacy (Google Only)

Only needed when `AI_PROVIDER=google`:

- `CHATBOT_GEMINI_API_KEY`
- `ACCOUNTANT_GEMINI_API_KEY`
- `ANALYST_GEMINI_API_KEY`
- `COACH_GEMINI_API_KEY`

---

## Rollback Plan

To switch back to Google Gemini:

1. Update `.env`:

   ```env
   AI_PROVIDER=google
   CHATBOT_GEMINI_API_KEY=your_key
   ACCOUNTANT_GEMINI_API_KEY=your_key
   ANALYST_GEMINI_API_KEY=your_key
   COACH_GEMINI_API_KEY=your_key
   ```

2. Restart the application

No code changes needed - the dual-provider pattern supports both.

---

## Cost Comparison

**Claude 3.5 Sonnet** (Bedrock):

- Input: ~$3 per 1M tokens
- Output: ~$15 per 1M tokens

**Gemini 2.0 Pro** (Google):

- Input: Free tier available, then ~$0.125-0.50 per 1M tokens
- Output: ~$0.375-1.50 per 1M tokens

**Claude 3.5 Haiku** (Bedrock - budget option):

- Input: ~$1 per 1M tokens
- Output: ~$5 per 1M tokens

Estimate for this system (assuming moderate usage):

- ~50-100k tokens/day → $5-15/month with Sonnet
- ~50-100k tokens/day → $2-5/month with Haiku

---

## Troubleshooting

### Error: "Cannot find module '@ai-sdk/amazon-bedrock'"

**Solution**: Run `npm install`

### Error: "Access denied" or "Model not found"

**Solution**: Request model access in AWS Bedrock console (see step 3 above)

### Error: "Invalid AWS credentials"

**Solution**: Verify `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in `.env`

### Error: "ValidationException: The provided model identifier is invalid"

**Solution**: Check model ID format. Use full ID like `anthropic.claude-3-5-sonnet-20241022-v2:0`, not short names.

### Agent returns poor quality responses

**Solution**: Try different model or adjust temperature in code (if needed)

---

## Next Steps (Optional Enhancements)

1. **Add prompt caching** (Bedrock feature) for cost optimization on repeated contexts
2. **Implement streaming responses** for better UX (Vercel AI SDK supports this)
3. **Add observability** (Helicone, Langfuse) for monitoring LLM calls
4. **Fine-tune prompts** for Claude (different style than Gemini)
5. **Add cost tracking** to monitor Bedrock usage

---

## References

- [Vercel AI SDK - Amazon Bedrock Provider](https://sdk.vercel.ai/providers/ai-sdk-providers/amazon-bedrock)
- [AWS Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)
- [Anthropic Claude Models](https://docs.anthropic.com/claude/docs)
- [AWS Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/)

---

**Migration completed**: October 20, 2025
