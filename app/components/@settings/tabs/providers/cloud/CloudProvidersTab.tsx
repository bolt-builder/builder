import { useEffect, useState, useCallback } from 'react';
import { useStore } from '@nanostores/react';
import { Switch } from '~/components/ui/Switch';
import { useSettings } from '~/lib/hooks/useSettings';
import type { IProviderConfig } from '~/types/model';
import { logStore } from '~/lib/stores/logs';
import { motion } from 'framer-motion';
import { cn } from '~/utils/cn';
import { toast } from 'sonner';
import { getApiKeysFromCookies } from '~/components/chat/APIKeyManager';
import { envKeyStatusStore, checkCloudProviderEnvKeys } from '~/lib/stores/settings';
import { CloudProviderCard } from './CloudProviderCard';

// Add type for provider names to ensure type safety
type ProviderName =
  | 'AmazonBedrock'
  | 'Anthropic'
  | 'AzureOpenAI'
  | 'Cohere'
  | 'Deepseek'
  | 'Github'
  | 'Google'
  | 'GoogleVertex'
  | 'Groq'
  | 'HuggingFace'
  | 'IBMWatsonx'
  | 'Hyperbolic'
  | 'Mistral'
  | 'OpenAI'
  | 'OpenRouter'
  | 'Perplexity'
  | 'Together'
  | 'XAI'
  | 'Cerebras'
  | 'Fireworks'
  | 'Moonshot'
  | 'Zai';

// Phosphor UnoCSS icon classes for each provider
const PROVIDER_ICONS: Record<ProviderName, string> = {
  AmazonBedrock: 'i-ph:amazon-logo',
  Anthropic: 'i-ph:brain',
  AzureOpenAI: 'i-ph:windows-logo',
  Cerebras: 'i-ph:cpu',
  Cohere: 'i-ph:cpu',
  Deepseek: 'i-ph:code',
  Fireworks: 'i-ph:fire',
  Github: 'i-ph:github-logo',
  Google: 'i-ph:google-logo',
  GoogleVertex: 'i-ph:google-logo',
  Groq: 'i-ph:lightning',
  HuggingFace: 'i-ph:robot',
  IBMWatsonx: 'i-ph:buildings',
  Hyperbolic: 'i-ph:infinity',
  Mistral: 'i-ph:wind',
  Moonshot: 'i-ph:moon',
  OpenAI: 'i-ph:brain',
  OpenRouter: 'i-ph:signpost',
  Perplexity: 'i-ph:sparkle',
  Together: 'i-ph:users-three',
  XAI: 'i-ph:atom',
  Zai: 'i-ph:robot',
};

// Provider descriptions
const PROVIDER_DESCRIPTIONS: Partial<Record<ProviderName, string>> = {
  AmazonBedrock: 'Access AI models through AWS Bedrock',
  Anthropic: 'Access Claude and other Anthropic models',
  AzureOpenAI: 'OpenAI models hosted on Azure (key as JSON with resourceName or baseUrl)',
  Cerebras: 'Ultra-fast inference with Cerebras hardware',
  Cohere: 'NLP and generation models by Cohere',
  Deepseek: 'Advanced reasoning and coding models',
  Fireworks: 'Fast inference on open-source models',
  Github: 'Use OpenAI models hosted through GitHub',
  Google: 'Gemini and other Google AI models',
  GoogleVertex: 'Gemini on Google Cloud Vertex AI (key as service-account JSON)',
  Groq: 'Ultra-low latency LLM inference',
  HuggingFace: 'Open-source models from HuggingFace',
  IBMWatsonx: 'IBM Granite models via the watsonx.ai model gateway',
  Hyperbolic: 'Scalable AI model serving',
  Mistral: 'European AI models by Mistral AI',
  Moonshot: 'Chinese and multilingual AI models',
  OpenAI: 'GPT-4, GPT-3.5, and other OpenAI models',
  OpenRouter: 'Unified gateway to 100+ AI models',
  Perplexity: 'AI-powered search and generation',
  Together: 'Run open-source models at scale',
  XAI: 'Grok models from xAI',
  Zai: 'AI models and services',
};

const CloudProvidersTab = () => {
  const settings = useSettings();
  const [filteredProviders, setFilteredProviders] = useState<IProviderConfig[]>([]);
  const [categoryEnabled, setCategoryEnabled] = useState<boolean>(false);
  const [isCheckingEnvKeys, setIsCheckingEnvKeys] = useState(true);
  const envKeyStatus = useStore(envKeyStatusStore);

  // Refresh env key status when tab mounts (force refresh to get latest)
  useEffect(() => {
    let cancelled = false;

    checkCloudProviderEnvKeys(true).finally(() => {
      if (!cancelled) {
        setIsCheckingEnvKeys(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Load and filter providers
  useEffect(() => {
    const newFilteredProviders = Object.entries(settings.providers || {})
      .filter(([key]) => !['Ollama', 'LMStudio', 'OpenAILike'].includes(key))
      .map(([key, value]) => ({
        name: key,
        settings: value.settings,
        staticModels: value.staticModels || [],
        getDynamicModels: value.getDynamicModels,
        getApiKeyLink: value.getApiKeyLink,
        labelForGetApiKey: value.labelForGetApiKey,
        icon: value.icon,
      }));

    const sorted = newFilteredProviders.sort((a, b) => a.name.localeCompare(b.name));
    setFilteredProviders(sorted);

    // Update category enabled state
    const allEnabled = newFilteredProviders.every((p) => p.settings.enabled);
    setCategoryEnabled(allEnabled);
  }, [settings.providers]);

  const handleToggleCategory = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        // Only enable providers that have API keys set (cookie or env)
        const keys = getApiKeysFromCookies();
        let enabledCount = 0;

        filteredProviders.forEach((provider) => {
          const hasCookieKey = Boolean(keys[provider.name]?.trim());
          const hasEnvKey = envKeyStatus[provider.name]?.hasEnvKey ?? false;

          if (hasCookieKey || hasEnvKey) {
            settings.updateProviderSettings(provider.name, { ...provider.settings, enabled: true });
            enabledCount++;
          }
        });

        if (enabledCount > 0) {
          setCategoryEnabled(true);
          toast.success(`Enabled ${enabledCount} provider(s) with API keys`);
        } else {
          toast.info('No providers have API keys configured. Add keys first, then enable.');
        }
      } else {
        // Disable all providers
        filteredProviders.forEach((provider) => {
          settings.updateProviderSettings(provider.name, { ...provider.settings, enabled: false });
        });

        setCategoryEnabled(false);
        toast.success('All cloud providers disabled');
      }
    },
    [filteredProviders, settings, envKeyStatus],
  );

  const handleToggleProvider = useCallback(
    (provider: IProviderConfig, enabled: boolean) => {
      // Update the provider settings in the store
      settings.updateProviderSettings(provider.name, { ...provider.settings, enabled });

      if (enabled) {
        logStore.logProvider(`Provider ${provider.name} enabled`, { provider: provider.name });
        toast.success(`${provider.name} enabled`);
      } else {
        logStore.logProvider(`Provider ${provider.name} disabled`, { provider: provider.name });
        toast.success(`${provider.name} disabled`);
      }
    },
    [settings],
  );

  if (isCheckingEnvKeys) {
    return (
      <div className={cn('flex flex-col items-center justify-center py-12 gap-3')}>
        <div
          className="i-svg-spinners:90-ring-with-bg text-devonz-elements-loader-progress"
          style={{ fontSize: '2rem' }}
        />
        <p className="text-sm text-devonz-elements-textSecondary">Loading provider status…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <motion.div
        className="space-y-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="flex items-center justify-between gap-4 mt-8 mb-4">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'w-8 h-8 flex items-center justify-center rounded-lg',
                'bg-devonz-elements-background-depth-3',
                'text-devonz-elements-item-contentAccent',
              )}
            >
              <div className="i-ph:cloud w-5 h-5" />
            </div>
            <div>
              <h4 className="text-md font-medium text-devonz-elements-textPrimary">Cloud Providers</h4>
              <p className="text-sm text-devonz-elements-textSecondary">
                Connect to cloud-based AI models and services
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-devonz-elements-textSecondary">Enable All Cloud</span>
            <Switch checked={categoryEnabled} onCheckedChange={handleToggleCategory} />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredProviders.map((provider, index) => (
            <CloudProviderCard
              key={provider.name}
              provider={provider}
              index={index}
              onToggle={handleToggleProvider}
              iconClass={PROVIDER_ICONS[provider.name as ProviderName] || 'i-ph:robot'}
              description={PROVIDER_DESCRIPTIONS[provider.name as ProviderName] || 'AI provider integration'}
            />
          ))}
        </div>
      </motion.div>
    </div>
  );
};

export default CloudProvidersTab;
