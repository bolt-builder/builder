import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('GithubProvider');

export default class GithubProvider extends BaseProvider {
  name = 'Github';
  getApiKeyLink = 'https://github.com/settings/personal-access-tokens';

  config = {
    apiTokenKey: 'GITHUB_API_KEY',
  };

  /*
   * GitHub Models - Available models through GitHub's native API
   * Updated for the new GitHub Models API at https://models.github.ai
   * Model IDs use the format: publisher/model-name
   */
  staticModels: ModelInfo[] = [
    { name: 'openai/gpt-4o', label: 'GPT-4o', provider: 'Github', maxTokenAllowed: 131072, maxCompletionTokens: 4096 },
    {
      name: 'openai/gpt-4o-mini',
      label: 'GPT-4o Mini',
      provider: 'Github',
      maxTokenAllowed: 131072,
      maxCompletionTokens: 4096,
    },
    {
      name: 'openai/gpt-5',
      label: 'GPT-5',
      provider: 'Github',
      maxTokenAllowed: 400000,
      maxCompletionTokens: 128000,
    },
    {
      name: 'openai/gpt-5-mini',
      label: 'GPT-5 Mini',
      provider: 'Github',
      maxTokenAllowed: 400000,
      maxCompletionTokens: 128000,
    },
    {
      name: 'openai/gpt-4.1',
      label: 'GPT-4.1',
      provider: 'Github',
      maxTokenAllowed: 1048576,
      maxCompletionTokens: 32768,
    },
    {
      name: 'openai/gpt-4.1-mini',
      label: 'GPT-4.1-mini',
      provider: 'Github',
      maxTokenAllowed: 1048576,
      maxCompletionTokens: 32768,
    },
    {
      name: 'deepseek/deepseek-r1',
      label: 'DeepSeek-R1',
      provider: 'Github',
      maxTokenAllowed: 128000,
      maxCompletionTokens: 4096,
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
      defaultApiTokenKey: 'GITHUB_API_KEY',
    });

    if (!apiKey) {
      logger.info('GitHub: No API key found. Make sure GITHUB_API_KEY is set in your .env.local file');

      // Return static models if no API key is available
      return this.staticModels;
    }

    logger.debug('GitHub: API key found, attempting to fetch dynamic models...');

    try {
      // Try to fetch dynamic models from GitHub API
      const response = await fetch('https://models.github.ai/v1/models', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: this.createTimeoutSignal(5000),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          data?: Array<{
            id: string;
            name?: string;
            limits?: { max_input_tokens?: number; max_output_tokens?: number };
          }>;
        };
        logger.info('GitHub: Successfully fetched models from API');

        if (data.data && Array.isArray(data.data)) {
          return data.data.map((model) => ({
            name: model.id,
            label: model.name || model.id.split('/').pop() || model.id,
            provider: 'Github',
            maxTokenAllowed: model.limits?.max_input_tokens || 128000,
            maxCompletionTokens: model.limits?.max_output_tokens || 16384,
          }));
        }
      } else {
        logger.warn('GitHub: API request failed with status:', response.status, response.statusText);
      }
    } catch (error) {
      logger.warn('GitHub: Failed to fetch models, using static models:', error);
    }

    // Fallback to static models
    logger.debug('GitHub: Using static models as fallback');

    return this.staticModels;
  }

  getModelInstance(options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    const { model, serverEnv, apiKeys, providerSettings } = options;

    logger.debug(`GitHub: Creating model instance for ${model}`);

    const { apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv,
      defaultBaseUrlKey: '',
      defaultApiTokenKey: 'GITHUB_API_KEY',
    });

    if (!apiKey) {
      logger.error('GitHub: No API key found');
      throw new Error(`Missing API key for ${this.name} provider`);
    }

    logger.debug(`GitHub: Using API key (first 8 chars): ${apiKey.substring(0, 8)}...`);

    const openai = createOpenAI({
      baseURL: 'https://models.github.ai/inference',
      apiKey,
    });

    logger.debug(`GitHub: Created OpenAI client, requesting model: ${model}`);

    return openai(model);
  }
}
