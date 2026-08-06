import { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '@nanostores/react';
import Cookies from 'js-cookie';
import { toast } from 'sonner';
import { cn } from '~/utils/cn';
import { Switch } from '~/components/ui/Switch';
import { getApiKeysFromCookies } from '~/components/chat/APIKeyManager';
import { envKeyStatusStore, preferredModelsStore, updatePreferredModel } from '~/lib/stores/settings';
import { encryptApiKeyValue, isEncryptedValue } from '~/lib/api/encrypt-value';
import type { IProviderConfig } from '~/types/model';
import type { ModelInfo } from '~/lib/modules/llm/types';

interface CloudProviderCardProps {
  provider: IProviderConfig;
  index: number;
  onToggle: (provider: IProviderConfig, enabled: boolean) => void;
  iconClass: string;
  description: string;
}

export function CloudProviderCard({ provider, index, onToggle, iconClass, description }: CloudProviderCardProps) {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [testError, setTestError] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsExpanded, setModelsExpanded] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);

  // Subscribe to env key status store (guard against undefined store value)
  const envKeyStatus = useStore(envKeyStatusStore) ?? {};
  const providerEnvStatus = envKeyStatus[provider.name];
  const hasEnvKey = providerEnvStatus?.hasEnvKey ?? false;

  // Subscribe to preferred models store (reactive — syncs with chat model selector)
  const preferredModels = useStore(preferredModelsStore);
  const selectedModel = preferredModels[provider.name] || '';

  // Determine if provider has any key (cookie or env)
  const hasAnyKey = hasKey || hasEnvKey;

  // Load existing API key from cookie
  useEffect(() => {
    const keys = getApiKeysFromCookies();
    const existing = keys[provider.name] || '';

    if (existing && isEncryptedValue(existing)) {
      // Encrypted key present — don't display ciphertext in the input
      setApiKey('');
      setHasKey(true);
    } else {
      setApiKey(existing);
      setHasKey(existing.length > 0);
    }
  }, [provider.name]);

  // No need for cookie-based preferred model loading — handled reactively via preferredModelsStore

  // Auto-fetch models when provider is enabled with a valid key
  useEffect(() => {
    if (provider.settings.enabled && hasAnyKey && models.length === 0 && !loadingModels) {
      fetchModels();
    }
  }, [provider.settings.enabled, hasAnyKey]);

  const fetchModels = useCallback(async () => {
    setLoadingModels(true);

    try {
      const response = await fetch(`/api/models/${encodeURIComponent(provider.name)}`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as { modelList?: ModelInfo[] };
      const fetchedModels = data.modelList ?? [];

      // Merge static + dynamic models, deduplicate
      const allModels = [...provider.staticModels, ...fetchedModels];
      const uniqueModels = allModels.filter((model, idx, arr) => arr.findIndex((m) => m.name === model.name) === idx);

      setModels(uniqueModels);
    } catch {
      // Silently fail for auto-fetch - user can still use Test button
    } finally {
      setLoadingModels(false);
    }
  }, [provider.name, provider.staticModels]);

  const savePreferredModel = useCallback(
    (modelName: string) => {
      updatePreferredModel(provider.name, modelName);
      toast.success(`Preferred model for ${provider.name} set to ${modelName}`);
    },
    [provider.name],
  );

  const saveApiKey = useCallback(
    async (value: string) => {
      try {
        const raw = Cookies.get('apiKeys');
        const parsed: Record<string, string> = raw ? JSON.parse(raw) : {};

        if (value.trim()) {
          const encrypted = await encryptApiKeyValue(value.trim());
          parsed[provider.name] = encrypted;
        } else {
          delete parsed[provider.name];
        }

        Cookies.set('apiKeys', JSON.stringify(parsed), {
          secure: window.location.protocol === 'https:',
          sameSite: 'strict',
          expires: 30,
        });
        setHasKey(value.trim().length > 0);
      } catch {
        toast.error('Failed to save API key');
      }
    },
    [provider.name],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        saveApiKey(apiKey);
        toast.success(`API key for ${provider.name} saved`);
      }
    },
    [apiKey, saveApiKey, provider.name],
  );

  const handleBlur = useCallback(() => {
    saveApiKey(apiKey);
  }, [apiKey, saveApiKey]);

  const testConnection = useCallback(async () => {
    if (!apiKey.trim() && !hasEnvKey) {
      toast.error('Please enter an API key first');
      return;
    }

    // Save the key first so the server can read it from the cookie
    if (apiKey.trim()) {
      saveApiKey(apiKey);
    }

    setTesting(true);
    setTestResult(null);
    setTestError('');
    setModels([]);

    try {
      const response = await fetch(`/api/models/${encodeURIComponent(provider.name)}`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as { modelList?: ModelInfo[] };
      const fetchedModels = data.modelList ?? [];

      // Merge static + dynamic models, deduplicate
      const allModels = [...provider.staticModels, ...fetchedModels];
      const uniqueModels = allModels.filter((model, idx, arr) => arr.findIndex((m) => m.name === model.name) === idx);

      setModels(uniqueModels);
      setTestResult('success');
      toast.success(`${provider.name}: ${uniqueModels.length} model(s) available`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      setTestResult('error');
      setTestError(message);
      toast.error(`${provider.name}: ${message}`);
    } finally {
      setTesting(false);
    }
  }, [apiKey, hasEnvKey, provider.name, provider.staticModels, saveApiKey]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.3 }}
      className={cn(
        'rounded-lg border border-bolt-elements-borderColor',
        'bg-bolt-elements-background-depth-2',
        'hover:bg-bolt-elements-background-depth-3',
        'transition-all duration-200',
        'p-4',
      )}
    >
      {/* Header row: icon, name, key-status dot, toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              iconClass,
              'w-6 h-6',
              provider.settings.enabled ? 'text-bolt-elements-item-contentAccent' : 'text-bolt-elements-textSecondary',
            )}
          />
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'text-sm font-medium',
                provider.settings.enabled ? 'text-bolt-elements-item-contentAccent' : 'text-bolt-elements-textPrimary',
              )}
            >
              {provider.name}
            </span>
            {/* Key status dot */}
            <span
              className={cn(
                'inline-block w-2 h-2 rounded-full flex-shrink-0',
                hasKey ? 'bg-green-500' : hasEnvKey ? 'bg-blue-500' : 'bg-gray-500',
              )}
              title={hasKey ? 'API key set' : hasEnvKey ? 'Server env key' : 'No API key'}
            />
          </div>
        </div>
        <Switch
          checked={provider.settings.enabled ?? false}
          onCheckedChange={(checked) => onToggle(provider, checked)}
        />
      </div>

      {/* Description */}
      {description && <p className="mt-1.5 ml-9 text-xs text-bolt-elements-textSecondary">{description}</p>}

      {/* Warning: enabled without API key */}
      {provider.settings.enabled && !hasAnyKey && (
        <div className="mt-1.5 ml-9 flex items-center gap-1.5 text-xs text-amber-400">
          <div className="i-ph:warning w-3.5 h-3.5 flex-shrink-0" />
          <span>Enabled without an API key — add a key for this provider to work</span>
        </div>
      )}

      {/* Server env key indicator */}
      {hasEnvKey && !hasKey && (
        <div className="mt-1.5 ml-9 flex items-center gap-1.5 text-xs text-blue-400">
          <div className="i-ph:server w-3.5 h-3.5 flex-shrink-0" />
          <span>Server API key configured via environment variable</span>
        </div>
      )}

      {/* API Key input section */}
      <div className="mt-3 ml-9 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              placeholder={`Enter ${provider.name} API key`}
              className={cn(
                'w-full px-3 py-1.5 pr-9 rounded-md text-sm',
                'bg-bolt-elements-background-depth-1',
                'border border-bolt-elements-borderColor',
                'text-bolt-elements-textPrimary',
                'placeholder-bolt-elements-textTertiary',
                'focus:outline-none focus:ring-2 focus:ring-bolt-elements-borderColorActive',
              )}
            />
            <button
              type="button"
              onClick={() => setShowKey((prev) => !prev)}
              className="absolute right-2 top-1/2 -translate-y-1/2 bg-transparent border-none p-0 cursor-pointer text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
              title={showKey ? 'Hide key' : 'Show key'}
            >
              <div className={cn(showKey ? 'i-ph:eye-slash' : 'i-ph:eye', 'w-4 h-4')} />
            </button>
          </div>

          {/* Test connection button */}
          <button
            type="button"
            onClick={testConnection}
            disabled={testing}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm whitespace-nowrap',
              'bg-transparent border border-bolt-elements-borderColor',
              'text-bolt-elements-textSecondary',
              'hover:text-bolt-elements-item-contentAccent hover:border-bolt-elements-borderColorActive',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors duration-150',
            )}
          >
            {testing ? (
              <div className="i-ph:spinner-gap w-4 h-4 animate-spin" />
            ) : testResult === 'success' ? (
              <div className="i-ph:check-circle w-4 h-4 text-green-500" />
            ) : testResult === 'error' ? (
              <div className="i-ph:x-circle w-4 h-4 text-red-500" />
            ) : (
              <div className="i-ph:plugs-connected w-4 h-4" />
            )}
            Test
          </button>
        </div>

        {/* Get API key link */}
        {provider.getApiKeyLink && !hasKey && (
          <a
            href={provider.getApiKeyLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-bolt-elements-item-contentAccent hover:underline"
          >
            <div className="i-ph:arrow-square-out w-3 h-3" />
            {provider.labelForGetApiKey || 'Get API Key'}
          </a>
        )}

        {/* Test error message */}
        <AnimatePresence>
          {testResult === 'error' && testError && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="text-xs text-red-400"
            >
              {testError}
            </motion.p>
          )}
        </AnimatePresence>

        {/* Model list (shown after successful test or auto-fetch) */}
        <AnimatePresence>
          {models.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <button
                type="button"
                onClick={() => setModelsExpanded((prev) => !prev)}
                className={cn(
                  'flex items-center gap-1.5 text-xs bg-transparent border-none p-0 cursor-pointer',
                  'text-bolt-elements-textSecondary hover:text-bolt-elements-item-contentAccent',
                  'transition-colors duration-150',
                )}
              >
                <div
                  className={cn(
                    'i-ph:caret-right w-3 h-3 transition-transform duration-200',
                    modelsExpanded && 'rotate-90',
                  )}
                />
                <span className="text-green-500 font-medium">{models.length}</span>
                <span>model{models.length !== 1 ? 's' : ''} available</span>
                {selectedModel && (
                  <span className="ml-1 text-bolt-elements-item-contentAccent">— using {selectedModel}</span>
                )}
              </button>

              <AnimatePresence>
                {modelsExpanded && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mt-1.5 overflow-hidden"
                  >
                    <div
                      className={cn(
                        'max-h-[160px] overflow-y-auto rounded-md p-2',
                        'bg-bolt-elements-background-depth-1',
                        'border border-bolt-elements-borderColor',
                      )}
                    >
                      {models.map((model) => (
                        <button
                          type="button"
                          key={model.name}
                          onClick={() => savePreferredModel(model.name)}
                          className={cn(
                            'w-full flex items-center gap-2 py-1.5 px-2 rounded text-left',
                            'text-xs cursor-pointer border-none',
                            'transition-colors duration-100',
                            selectedModel === model.name
                              ? 'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent'
                              : 'bg-transparent text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-2',
                          )}
                        >
                          <div
                            className={cn(
                              'w-3 h-3 flex-shrink-0',
                              selectedModel === model.name
                                ? 'i-ph:check-circle-fill text-bolt-elements-item-contentAccent'
                                : 'i-ph:circle text-bolt-elements-textTertiary',
                            )}
                          />
                          <span className="truncate">{model.label || model.name}</span>
                        </button>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Loading models indicator */}
        {loadingModels && (
          <div className="flex items-center gap-1.5 text-xs text-bolt-elements-textTertiary">
            <div className="i-ph:spinner-gap w-3 h-3 animate-spin" />
            <span>Loading models...</span>
          </div>
        )}
      </div>
    </motion.div>
  );
}
