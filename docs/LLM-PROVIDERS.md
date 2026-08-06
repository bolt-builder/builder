# LLM Providers

> Provider system architecture and how to add new LLM providers to Bolt.

---

## Overview

Bolt supports **22 LLM providers** through a pluggable provider system built on the [Vercel AI SDK](https://sdk.vercel.ai/). Each provider is a self-contained class that extends `BaseProvider`.

---

## Supported Providers

| Provider | API Key Env Var | Dynamic Models | Notes |
| -------- | --------------- | -------------- | ----- |
| OpenAI | `OPENAI_API_KEY` | Yes | GPT-4o, GPT-3.5, o1 series |
| Anthropic | `ANTHROPIC_API_KEY` | Yes | Claude 3.5 Sonnet, Claude 4 Opus |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` | Yes | Gemini models |
| Mistral | `MISTRAL_API_KEY` | Yes | Mistral Large, Medium, Small |
| DeepSeek | `DEEPSEEK_API_KEY` | No | DeepSeek Chat, Coder |
| Groq | `GROQ_API_KEY` | Yes | Llama, Mixtral on Groq hardware |
| Cohere | `COHERE_API_KEY` | No | Command R+ |
| HuggingFace | `HuggingFace_API_KEY` | No | Inference API models |
| OpenRouter | `OPEN_ROUTER_API_KEY` | Yes | Multi-provider routing |
| Together | `TOGETHER_API_KEY` | Yes | Open-source models |
| XAI | `XAI_API_KEY` | No | Grok models |
| Perplexity | `PERPLEXITY_API_KEY` | No | Perplexity Sonar |
| Amazon Bedrock | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | No | AWS-hosted models |
| GitHub | `GITHUB_API_KEY` | No | GitHub Models API |
| Moonshot | `MOONSHOT_API_KEY` | No | Kimi models |
| Hyperbolic | `HYPERBOLIC_API_KEY` | No | Hyperbolic inference |
| Ollama | `OLLAMA_API_BASE_URL` | Yes | Local models (no API key) |
| LM Studio | `LMSTUDIO_API_BASE_URL` | Yes | Local models (no API key) |
| Z.ai | `ZAI_API_KEY` | No | 10 static GLM models optimized for coding tasks |
| Fireworks | `FIREWORKS_API_KEY` | No | Qwen, Llama, DeepSeek, Mixtral on Fireworks infrastructure |
| Cerebras | `CEREBRAS_API_KEY` | No | Qwen, Llama on Cerebras fast inference |
| OpenAI-Like | `OPENAI_LIKE_API_BASE_URL` | No | Any OpenAI-compatible API |

---

## Extended Thinking Support

Some providers support **Extended Thinking**, which lets the LLM show its reasoning process before generating a response:

| Provider | Mechanism | Configuration |
| -------- | --------- | ------------- |
| Anthropic Claude | `thinking` provider option | Configurable budget as a percentage of `maxTokens` |
| Google Gemini | `thinkingConfig` with `thinkingBudget` | Budget specified in token count |

Extended thinking can be enabled in **Settings → Features** tab. When active, the chat UI displays the model's reasoning steps in a collapsible section above the response.

---

## Architecture

```text
LLMManager (singleton)
    │
    ├── registerProvider()     # Auto-register from registry
    ├── getProvider(name)      # Get provider by name
    ├── getAllProviders()       # List all providers
    └── getModelList()         # Aggregate all models
         │
         ▼
    BaseProvider (abstract)
    ├── name: string
    ├── staticModels: ModelInfo[]
    ├── config: ProviderConfig
    ├── getModelInstance()      # Create AI SDK model
    ├── getDynamicModels?()     # Fetch models from API
    └── getProviderBaseUrlAndKey()  # Resolve credentials
         │
         ▼
    Concrete Providers
    ├── OpenAIProvider
    ├── AnthropicProvider
    ├── GoogleProvider
    └── ... (22 total)
```

### Key Files

| File | Purpose |
| ---- | ------- |
| `app/lib/modules/llm/manager.ts` | `LLMManager` singleton — registers and manages all providers |
| `app/lib/modules/llm/base-provider.ts` | `BaseProvider` abstract class with shared logic |
| `app/lib/modules/llm/types.ts` | `ModelInfo`, `ProviderInfo`, `ProviderConfig` interfaces |
| `app/lib/modules/llm/registry.ts` | Imports and exports all provider classes |
| `app/lib/modules/llm/providers/*.ts` | Individual provider implementations |

---

## Key Types

### ModelInfo

```typescript
interface ModelInfo {
  name: string;           // Model identifier (e.g., 'gpt-4o')
  label: string;          // Display name (e.g., 'GPT-4o')
  provider: string;       // Provider name (e.g., 'OpenAI')
  maxTokenAllowed: number; // Max context window (input tokens)
  maxCompletionTokens?: number; // Max output tokens
}
```

### ProviderConfig

```typescript
interface ProviderConfig {
  baseUrlKey?: string;    // Env var for custom base URL
  baseUrl?: string;       // Default base URL
  apiTokenKey?: string;   // Env var for API key
}
```

---

## Adding a New Provider

### Step 1: Create Provider File

Create `app/lib/modules/llm/providers/my-provider.ts`:

```typescript
import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { createOpenAI } from '@ai-sdk/openai'; // or appropriate SDK

export default class MyProvider extends BaseProvider {
  name = 'MyProvider';
  getApiKeyLink = 'https://my-provider.com/api-keys';

  config = {
    apiTokenKey: 'MY_PROVIDER_API_KEY',
    // Optional: baseUrlKey, baseUrl
  };

  staticModels: ModelInfo[] = [
    {
      name: 'my-model-v1',
      label: 'My Model V1',
      provider: 'MyProvider',
      maxTokenAllowed: 128000,
      maxCompletionTokens: 4096,
    },
  ];

  // Optional: fetch models dynamically from API
  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv?: Env,
  ): Promise<ModelInfo[]> {
    const { apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv,
      defaultBaseUrlKey: '',
      defaultApiTokenKey: 'MY_PROVIDER_API_KEY',
    });

    if (!apiKey) {
      throw `Missing API key for ${this.name}`;
    }

    // Fetch and return models from your provider's API
    return [];
  }

  getModelInstance(options: {
    model: string;
    serverEnv?: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    const { apiKey, baseUrl } = this.getProviderBaseUrlAndKey({
      apiKeys: options.apiKeys,
      providerSettings: options.providerSettings?.[this.name],
      serverEnv: options.serverEnv,
      defaultBaseUrlKey: '',
      defaultApiTokenKey: 'MY_PROVIDER_API_KEY',
    });

    const openai = createOpenAI({
      baseURL: baseUrl || 'https://api.my-provider.com/v1',
      apiKey,
    });

    return openai(options.model);
  }
}
```

### Step 2: Register in Registry

Add your provider to `app/lib/modules/llm/registry.ts`:

```typescript
import MyProvider from './providers/my-provider';

export {
  // ... existing exports
  MyProvider,
};
```

### Step 3: Add AI SDK Dependency (if needed)

If your provider has a dedicated Vercel AI SDK adapter:

```bash
pnpm add @ai-sdk/my-provider
```

Otherwise, use `createOpenAI` with a custom base URL for OpenAI-compatible APIs.

### Step 4: Test

Set your API key and verify the provider appears in the model selector:

```bash
MY_PROVIDER_API_KEY=your-key pnpm dev
```

---

## Credential Resolution

Provider credentials are resolved in this priority order:

1. **Client-side API keys** (from cookies, set via Settings UI)
2. **Server environment variables** (from request context)
3. **Process environment** (`process.env`)
4. **LLMManager environment** (`manager.env`)
5. **Provider default** (`config.baseUrl`)

This allows users to set keys via the UI without touching server config.

---

## Dynamic Model Caching

Providers with `getDynamicModels()` cache results to avoid repeated API calls:

- Cache key = `JSON.stringify({ apiKey, providerSettings, serverEnv })`
- Cache invalidates when any credential changes
- No TTL — cache persists until credentials change or server restarts

---

## Local Providers

Ollama, LM Studio, and OpenAI-Like are "local" providers with special behavior:

- **No API key required** (use base URL instead)
- **Models fetched dynamically** from the local server
- **Health monitoring** via `localModelHealthMonitor.ts` service
- **Configurable base URL** via Settings UI
