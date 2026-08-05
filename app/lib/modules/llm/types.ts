import type { LanguageModelV1 } from 'ai';
import type { IProviderSetting } from '~/types/model';

export interface ModelInfo {
  name: string;
  label: string;
  provider: string;

  /** Maximum context window size (input tokens) - how many tokens the model can process */
  maxTokenAllowed: number;

  /** Maximum completion/output tokens - how many tokens the model can generate. If not specified, falls back to provider defaults */
  maxCompletionTokens?: number;

  /**
   * Optional fallback model in "provider/model" format (e.g. "anthropic/claude-haiku-4-5-20251001").
   * When set, the system will retry with this model if the primary model call fails
   * due to rate limits, auth errors, or timeouts. Capped at 1 fallback attempt.
   */
  fallbackModel?: string;
}

export interface ProviderInfo {
  name: string;
  staticModels: ModelInfo[];
  getDynamicModels?: (
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv?: Record<string, string | undefined>,
  ) => Promise<ModelInfo[]>;
  getModelInstance: (options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }) => LanguageModelV1;
  getApiKeyLink?: string;
  labelForGetApiKey?: string;
  icon?: string;
}
export interface ProviderConfig {
  baseUrlKey?: string;
  baseUrl?: string;
  apiTokenKey?: string;
}
