import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';

/*
 * The /edge entry authenticates with Web Crypto instead of google-auth-library,
 * keeping Node-only modules out of the client bundle (providers are bundled
 * client-side via PROVIDER_LIST in ~/utils/constants).
 */
import { createVertex } from '@ai-sdk/google-vertex/edge';

/**
 * Google Vertex AI credentials. Like AWS Bedrock and Azure OpenAI, the
 * "API key" field carries JSON because Vertex needs more than a bare key.
 * Two shapes are accepted:
 *
 * 1. A pasted service-account key file (snake_case, as downloaded from GCP):
 *    { "project_id": "...", "client_email": "...", "private_key": "-----BEGIN..." }
 *
 * 2. A compact custom shape (camelCase):
 *    { "projectId": "...", "clientEmail": "...", "privateKey": "...", "location": "us-central1" }
 *
 * `location` is optional in both shapes and defaults to `us-central1`
 * (override with GOOGLE_VERTEX_LOCATION in the server environment).
 */
interface VertexConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  location: string;
}

const DEFAULT_LOCATION = 'us-central1';

export default class GoogleVertexProvider extends BaseProvider {
  name = 'GoogleVertex';
  getApiKeyLink = 'https://console.cloud.google.com/iam-admin/serviceaccounts';
  labelForGetApiKey = 'Create a GCP service account';

  config = {
    apiTokenKey: 'GOOGLE_VERTEX_CONFIG',
  };

  staticModels: ModelInfo[] = [
    {
      name: 'gemini-2.5-pro',
      label: 'Gemini 2.5 Pro (Vertex)',
      provider: 'GoogleVertex',
      maxTokenAllowed: 1048576,
    },
    {
      name: 'gemini-2.5-flash',
      label: 'Gemini 2.5 Flash (Vertex)',
      provider: 'GoogleVertex',
      maxTokenAllowed: 1048576,
    },
    {
      name: 'gemini-2.5-flash-lite',
      label: 'Gemini 2.5 Flash Lite (Vertex)',
      provider: 'GoogleVertex',
      maxTokenAllowed: 1048576,
    },
    {
      name: 'gemini-3-pro-preview',
      label: 'Gemini 3 Pro Preview (Vertex)',
      provider: 'GoogleVertex',
      maxTokenAllowed: 1048576,
    },
  ];

  private _parseConfig(raw: string, serverEnv?: Record<string, string | undefined>): VertexConfig {
    let parsed: Record<string, string | undefined> = {};

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        'Google Vertex AI needs service-account JSON. Paste the downloaded key file, or {"projectId": "...", "clientEmail": "...", "privateKey": "...", "location": "us-central1"}.',
      );
    }

    // Accept both the raw GCP key file (snake_case) and the compact camelCase shape.
    const projectId = parsed.projectId || parsed.project_id || serverEnv?.GOOGLE_VERTEX_PROJECT;
    const clientEmail = parsed.clientEmail || parsed.client_email;
    const privateKey = parsed.privateKey || parsed.private_key;
    const location = parsed.location || serverEnv?.GOOGLE_VERTEX_LOCATION || DEFAULT_LOCATION;

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        'Google Vertex AI config is missing project_id, client_email, or private_key. Paste the full service-account key JSON from GCP.',
      );
    }

    return { projectId, clientEmail, privateKey, location };
  }

  async getDynamicModels(
    _apiKeys?: Record<string, string>,
    _settings?: IProviderSetting,
    _serverEnv: Record<string, string | undefined> = {},
  ): Promise<ModelInfo[]> {
    // Vertex model discovery needs an OAuth token exchange; the static Gemini list covers current models.
    return [];
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
      defaultApiTokenKey: 'GOOGLE_VERTEX_CONFIG',
    });

    if (!apiKey) {
      throw new Error(`Missing API key for ${this.name} provider`);
    }

    const config = this._parseConfig(apiKey, serverEnv as unknown as Record<string, string | undefined>);

    const vertex = createVertex({
      project: config.projectId,
      location: config.location,
      googleCredentials: {
        clientEmail: config.clientEmail,

        // Pasted JSON often carries literal \n sequences in the private key.
        privateKey: config.privateKey.replace(/\\n/g, '\n'),
      },
    });

    return vertex(model);
  }
}
