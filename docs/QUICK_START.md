# Quick Start Guide

## Super Simple Setup (2 minutes)

### Option 1: AWS Bedrock (Recommended)

1. **Copy the example env file**:

   ```powershell
   cp .env.example .env
   ```

2. **Get AWS credentials** from [AWS IAM Console](https://console.aws.amazon.com/iam/)

3. **Edit `.env`** and add your keys:

   ```env
   AI_PROVIDER=bedrock
   AWS_ACCESS_KEY_ID=your_key_here
   AWS_SECRET_ACCESS_KEY=your_secret_here
   AWS_REGION=us-east-1
   ```

4. **Request model access** (one-time, instant):

   - Go to [AWS Bedrock Console](https://console.aws.amazon.com/bedrock/)
   - Click "Model access" → "Manage model access"
   - Enable "Anthropic Claude" models
   - Submit

5. **Run**:
   ```powershell
   npm install
   npm run dev
   ```

**That's it!** Models are auto-selected based on agent roles:

- **Chatbot/Analyst/Coach**: Claude 3.5 Sonnet (best quality)
- **Accountant**: Claude 3.5 Haiku (fast & cheap)

### Option 2: Google Gemini

1. **Copy and edit `.env`**:

   ```env
   AI_PROVIDER=google
   GOOGLE_API_KEY=your_google_api_key
   ```

2. **Get API key** from [Google AI Studio](https://makersuite.google.com/app/apikey)

3. **Run**:
   ```powershell
   npm install
   npm run dev
   ```

## Advanced: Custom Models

Want different models? Just set `AI_MODEL` in `.env`:

```env
# Use this model for all agents
AI_MODEL=anthropic.claude-3-5-haiku-20241022-v1:0
```

Or per-agent:

```env
CHATBOT_MODEL=anthropic.claude-3-5-sonnet-20241022-v2:0
ACCOUNTANT_MODEL=anthropic.claude-3-5-haiku-20241022-v1:0
```

## Available Models

### AWS Bedrock

- `anthropic.claude-3-5-sonnet-20241022-v2:0` - Best quality
- `anthropic.claude-3-5-haiku-20241022-v1:0` - Fast & cheap
- `us.amazon.nova-pro-v1:0` - AWS native
- `us.amazon.nova-lite-v1:0` - Ultra fast

### Google Gemini

- `gemini-2.0-flash-exp` - Fast & free tier
- `gemini-2.0-pro-exp` - Higher quality

## Troubleshooting

**"Cannot find module '@ai-sdk/amazon-bedrock'"**
→ Run `npm install`

**"Access denied" / "Model not found"**
→ Request model access in AWS Bedrock console (step 4 above)

**"Invalid credentials"**
→ Check your AWS keys in `.env`

## Full Documentation

See `docs/MIGRATION_AWS_BEDROCK.md` for detailed info.
