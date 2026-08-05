import { BaseProvider, getOpenAILikeModel } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('IBMWatsonx');

/**
 * IBM watsonx.ai — Granite models via IBM's OpenAI-compatible model gateway.
 *
 * The gateway lives at `https://<region>.ml.cloud.ibm.com/ml/gateway/v1` and
 * accepts the IBM Cloud API key directly as the bearer token. The default
 * region is us-south; override with the base URL setting or the
 * IBM_WATSONX_GATEWAY_URL environment variable.
 */
export default class IBMWatsonxProvider extends BaseProvider {
  name = 'IBMWatsonx';
  getApiKeyLink = 'https://cloud.ibm.com/iam/apikeys';
  labelForGetApiKey = 'Get IBM Cloud API key';

  config = {
    baseUrlKey: 'IBM_WATSONX_GATEWAY_URL',
    apiTokenKey: 'IBM_WATSONX_API_KEY',
    baseUrl: 'https://us-south.ml.cloud.ibm.com/ml/gateway/v1',
  };

  /*
   * Fallback catalog when the gateway's /models listing is unavailable.
   * The dynamic listing is authoritative for the account's enabled models.
   */
  staticModels: ModelInfo[] = [
    {
      name: 'ibm/granite-4-h-small',
      label: 'Granite 4 H Small (watsonx)',
      provider: 'IBMWatsonx',
      maxTokenAllowed: 128000,
    },
    {
      name: 'ibm/granite-3-3-8b-instruct',
      label: 'Granite 3.3 8B Instruct (watsonx)',
      provider: 'IBMWatsonx',
      maxTokenAllowed: 128000,
    },
  ];

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string | undefined> = {},
  ): Promise<ModelInfo[]> {
    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv,
      defaultBaseUrlKey: 'IBM_WATSONX_GATEWAY_URL',
      defaultApiTokenKey: 'IBM_WATSONX_API_KEY',
    });

    if (!baseUrl || !apiKey) {
      return [];
    }

    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: this.createTimeoutSignal(5000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const res = (await response.json()) as { data: Array<{ id: string }> };
      const staticNames = new Set(this.staticModels.map((m) => m.name));

      return res.data
        .filter((model) => !staticNames.has(model.id))
        .map((model) => ({
          name: model.id,
          label: `${model.id} (watsonx)`,
          provider: this.name,
          maxTokenAllowed: 128000,
        }));
    } catch (error) {
      logger.debug('Failed to list watsonx gateway models', error);
      return [];
    }
  }

  getModelInstance(options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    const { model, serverEnv, apiKeys, providerSettings } = options;

    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv,
      defaultBaseUrlKey: 'IBM_WATSONX_GATEWAY_URL',
      defaultApiTokenKey: 'IBM_WATSONX_API_KEY',
    });

    if (!baseUrl || !apiKey) {
      throw new Error(`Missing configuration for ${this.name} provider`);
    }

    return getOpenAILikeModel(baseUrl, apiKey, model);
  }
}
