import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { createAzure } from '@ai-sdk/azure';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('AzureOpenAI');

/**
 * Azure OpenAI credentials. Like AWS Bedrock, the "API key" field carries a
 * JSON config because Azure needs more than a bare key:
 *   { "apiKey": "...", "resourceName": "my-resource" }
 * or
 *   { "apiKey": "...", "baseUrl": "https://my-resource.openai.azure.com" }
 * A plain (non-JSON) key is also accepted when AZURE_OPENAI_RESOURCE_NAME is
 * set in the server environment.
 */
interface AzureOpenAIConfig {
  apiKey: string;
  resourceName?: string;
  baseUrl?: string;
  apiVersion?: string;
}

const DEPLOYMENTS_API_VERSION = '2023-03-15-preview';

export default class AzureOpenAIProvider extends BaseProvider {
  name = 'AzureOpenAI';
  getApiKeyLink = 'https://portal.azure.com/#browse/Microsoft.CognitiveServices%2Faccounts';
  labelForGetApiKey = 'Get Azure OpenAI access';

  config = {
    apiTokenKey: 'AZURE_OPENAI_CONFIG',
  };

  // Deployments are user-named in Azure, so there are no meaningful static model IDs.
  staticModels: ModelInfo[] = [];

  private _parseConfig(raw: string, serverEnv?: Record<string, string | undefined>): AzureOpenAIConfig {
    let parsed: Partial<AzureOpenAIConfig> = {};

    try {
      parsed = JSON.parse(raw);
    } catch {
      // Plain API key string — resource name must come from the environment.
      parsed = { apiKey: raw };
    }

    const apiKey = parsed.apiKey;
    const resourceName = parsed.resourceName || serverEnv?.AZURE_OPENAI_RESOURCE_NAME;
    const baseUrl = parsed.baseUrl || serverEnv?.AZURE_OPENAI_API_BASE_URL;

    if (!apiKey) {
      throw new Error(`Missing API key for ${this.name} provider`);
    }

    if (!resourceName && !baseUrl) {
      throw new Error(
        'Azure OpenAI needs a resource name or endpoint. Provide the key as JSON: {"apiKey": "...", "resourceName": "my-resource"} or {"apiKey": "...", "baseUrl": "https://my-resource.openai.azure.com"}.',
      );
    }

    return { apiKey, resourceName, baseUrl, apiVersion: parsed.apiVersion };
  }

  /** Root endpoint like https://my-resource.openai.azure.com (no trailing slash). */
  private _endpoint(config: AzureOpenAIConfig): string {
    if (config.baseUrl) {
      return config.baseUrl.replace(/\/openai\/deployments\/?$/, '').replace(/\/$/, '');
    }

    return `https://${config.resourceName}.openai.azure.com`;
  }

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string | undefined> = {},
  ): Promise<ModelInfo[]> {
    const { apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv,
      defaultBaseUrlKey: '',
      defaultApiTokenKey: 'AZURE_OPENAI_CONFIG',
    });

    if (!apiKey) {
      return [];
    }

    try {
      const config = this._parseConfig(apiKey, serverEnv);
      const endpoint = this._endpoint(config);

      const response = await fetch(`${endpoint}/openai/deployments?api-version=${DEPLOYMENTS_API_VERSION}`, {
        headers: { 'api-key': config.apiKey },
        signal: this.createTimeoutSignal(5000),
      });

      if (!response.ok) {
        throw new Error(`Azure OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const res = (await response.json()) as { data: Array<{ id: string; model?: string }> };

      return res.data.map((deployment) => ({
        name: deployment.id,
        label: deployment.model ? `${deployment.id} (${deployment.model})` : deployment.id,
        provider: this.name,
        maxTokenAllowed: 128000,
      }));
    } catch (error) {
      logger.debug('Failed to list Azure OpenAI deployments', error);
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

    const { apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv,
      defaultBaseUrlKey: '',
      defaultApiTokenKey: 'AZURE_OPENAI_CONFIG',
    });

    if (!apiKey) {
      throw new Error(`Missing API key for ${this.name} provider`);
    }

    const config = this._parseConfig(apiKey, serverEnv as unknown as Record<string, string | undefined>);
    const azure = createAzure({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: `${this._endpoint(config)}/openai/deployments` } : {}),
      ...(config.resourceName && !config.baseUrl ? { resourceName: config.resourceName } : {}),
      ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
    });

    return azure(model);
  }
}
