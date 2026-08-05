import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { createCohere } from '@ai-sdk/cohere';

export default class CohereProvider extends BaseProvider {
  name = 'Cohere';
  getApiKeyLink = 'https://dashboard.cohere.com/api-keys';

  config = {
    apiTokenKey: 'COHERE_API_KEY',
  };

  staticModels: ModelInfo[] = [
    /*
     * Current model IDs only. The legacy command / command-light /
     * command-nightly family was deprecated by Cohere.
     */
    {
      name: 'command-a-03-2025',
      label: 'Command A',
      provider: 'Cohere',
      maxTokenAllowed: 256000,
      maxCompletionTokens: 8192,
    },
    {
      name: 'command-r-plus-08-2024',
      label: 'Command R plus',
      provider: 'Cohere',
      maxTokenAllowed: 128000,
      maxCompletionTokens: 4000,
    },
    {
      name: 'command-r-08-2024',
      label: 'Command R',
      provider: 'Cohere',
      maxTokenAllowed: 128000,
      maxCompletionTokens: 4000,
    },
    {
      name: 'command-r7b-12-2024',
      label: 'Command R7B',
      provider: 'Cohere',
      maxTokenAllowed: 128000,
      maxCompletionTokens: 4000,
    },
    {
      name: 'c4ai-aya-expanse-8b',
      label: 'c4AI Aya Expanse 8b',
      provider: 'Cohere',
      maxTokenAllowed: 4096,
      maxCompletionTokens: 4000,
    },
    {
      name: 'c4ai-aya-expanse-32b',
      label: 'c4AI Aya Expanse 32b',
      provider: 'Cohere',
      maxTokenAllowed: 4096,
      maxCompletionTokens: 4000,
    },
  ];

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
      defaultApiTokenKey: 'COHERE_API_KEY',
    });

    if (!apiKey) {
      throw new Error(`Missing API key for ${this.name} provider`);
    }

    const cohere = createCohere({
      apiKey,
    });

    return cohere(model);
  }
}
