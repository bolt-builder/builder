import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

export default class OpenAIProvider extends BaseProvider {
  name = 'OpenAI';
  getApiKeyLink = 'https://platform.openai.com/api-keys';

  config = {
    apiTokenKey: 'OPENAI_API_KEY',
  };

  staticModels: ModelInfo[] = [
    /*
     * Essential fallback models - current, non-retired model IDs only.
     * (o1-preview and o1-mini are retired; gpt-3.5-turbo is legacy.)
     * GPT-5.1: 400k context, flagship reasoning model
     */
    { name: 'gpt-5.1', label: 'GPT-5.1', provider: 'OpenAI', maxTokenAllowed: 400000, maxCompletionTokens: 128000 },

    // GPT-5: 400k context, reasoning model
    { name: 'gpt-5', label: 'GPT-5', provider: 'OpenAI', maxTokenAllowed: 400000, maxCompletionTokens: 128000 },

    // GPT-5 Mini: 400k context, cost-effective reasoning model
    {
      name: 'gpt-5-mini',
      label: 'GPT-5 Mini',
      provider: 'OpenAI',
      maxTokenAllowed: 400000,
      maxCompletionTokens: 128000,
    },

    // GPT-4.1: 1M context, strong non-reasoning coding model
    { name: 'gpt-4.1', label: 'GPT-4.1', provider: 'OpenAI', maxTokenAllowed: 1000000, maxCompletionTokens: 32768 },

    // GPT-4o: 128k context
    { name: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI', maxTokenAllowed: 128000, maxCompletionTokens: 16384 },

    // GPT-4o Mini: 128k context, cost-effective alternative
    {
      name: 'gpt-4o-mini',
      label: 'GPT-4o Mini',
      provider: 'OpenAI',
      maxTokenAllowed: 128000,
      maxCompletionTokens: 16384,
    },
  ];

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
      defaultApiTokenKey: 'OPENAI_API_KEY',
    });

    if (!apiKey) {
      throw new Error(`Missing Api Key configuration for ${this.name} provider`);
    }

    const response = await fetch(`https://api.openai.com/v1/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: this.createTimeoutSignal(5000),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const res = (await response.json()) as { data: Array<{ id: string; object?: string; context_length?: number }> };
    const staticModelIds = this.staticModels.map((m) => m.name);

    const data = res.data.filter(
      (model) =>
        model.object === 'model' &&
        (model.id.startsWith('gpt-') || model.id.startsWith('o') || model.id.startsWith('chatgpt-')) &&
        !staticModelIds.includes(model.id),
    );

    return data.map((m) => {
      // Get accurate context window from OpenAI API
      let contextWindow = 32000; // default fallback

      // OpenAI provides context_length in their API response
      if (m.context_length) {
        contextWindow = m.context_length;
      } else if (m.id?.includes('gpt-4o')) {
        contextWindow = 128000; // GPT-4o has 128k context
      } else if (m.id?.includes('gpt-4-turbo') || m.id?.includes('gpt-4-1106')) {
        contextWindow = 128000; // GPT-4 Turbo has 128k context
      } else if (m.id?.includes('gpt-4')) {
        contextWindow = 8192; // Standard GPT-4 has 8k context
      } else if (m.id?.includes('gpt-3.5-turbo')) {
        contextWindow = 16385; // GPT-3.5-turbo has 16k context
      }

      // Determine completion token limits based on model type (accurate 2025 limits)
      let maxCompletionTokens = 4096; // default for most models

      if (m.id?.startsWith('o1-preview')) {
        maxCompletionTokens = 32000; // o1-preview: 32K output limit
      } else if (m.id?.startsWith('o1-mini')) {
        maxCompletionTokens = 65000; // o1-mini: 65K output limit
      } else if (m.id?.startsWith('o1')) {
        maxCompletionTokens = 32000; // Other o1 models: 32K limit
      } else if (m.id?.includes('o3') || m.id?.includes('o4')) {
        maxCompletionTokens = 100000; // o3/o4 models: 100K output limit
      } else if (m.id?.includes('gpt-4o')) {
        maxCompletionTokens = 4096; // GPT-4o standard: 4K (64K with long output mode)
      } else if (m.id?.includes('gpt-4')) {
        maxCompletionTokens = 8192; // Standard GPT-4: 8K output limit
      } else if (m.id?.includes('gpt-3.5-turbo')) {
        maxCompletionTokens = 4096; // GPT-3.5-turbo: 4K output limit
      }

      return {
        name: m.id,
        label: `${m.id} (${Math.floor(contextWindow / 1000)}k context)`,
        provider: this.name,
        maxTokenAllowed: Math.min(contextWindow, 128000), // Cap at 128k for safety
        maxCompletionTokens,
      };
    });
  }

  getModelInstance(options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    const { model, serverEnv, apiKeys, providerSettings } = options;

    const { apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv,
      defaultBaseUrlKey: '',
      defaultApiTokenKey: 'OPENAI_API_KEY',
    });

    if (!apiKey) {
      throw new Error(`Missing API key for ${this.name} provider`);
    }

    const openai = createOpenAI({
      apiKey,
    });

    return openai(model);
  }
}
