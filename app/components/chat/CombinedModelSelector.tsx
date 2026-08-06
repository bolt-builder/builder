import type { ProviderInfo } from '~/types/model';
import type { ModelInfo } from '~/lib/modules/llm/types';
import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import type { KeyboardEvent } from 'react';
import { useStore } from '@nanostores/react';
import { cn } from '~/utils/cn';
import {
  envKeyStatusStore,
  updateProviderSettings,
  updatePreferredModel,
  preferredModelsStore,
} from '~/lib/stores/settings';
import { PROVIDER_LIST } from '~/utils/constants';

// Fuzzy search utilities (same as ModelSelector)
const levenshteinDistance = (str1: string, str2: string): number => {
  const matrix = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
  }

  return matrix[str2.length][str1.length];
};

const fuzzyMatch = (query: string, text: string): { score: number; matches: boolean } => {
  if (!query) {
    return { score: 0, matches: true };
  }

  if (!text) {
    return { score: 0, matches: false };
  }

  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  if (textLower.includes(queryLower)) {
    return { score: 100 - (textLower.indexOf(queryLower) / textLower.length) * 20, matches: true };
  }

  const distance = levenshteinDistance(queryLower, textLower);
  const maxLen = Math.max(queryLower.length, textLower.length);
  const similarity = 1 - distance / maxLen;

  return {
    score: similarity > 0.6 ? similarity * 80 : 0,
    matches: similarity > 0.6,
  };
};

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const highlightText = (text: string, query: string): string => {
  const escaped = escapeHtml(text);

  if (!query) {
    return escaped;
  }

  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');

  return escaped.replace(regex, '<mark class="bg-[#3d5a7f]/40 text-current rounded px-0.5">$1</mark>');
};

const formatContextSize = (tokens: number): string => {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }

  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(0)}K`;
  }

  return tokens.toString();
};

// Helper function to determine if a model is likely free
const isModelLikelyFree = (model: ModelInfo, providerName?: string): boolean => {
  if (providerName === 'OpenRouter' && model.label.includes('in:$0.00') && model.label.includes('out:$0.00')) {
    return true;
  }

  if (model.name.toLowerCase().includes('free') || model.label.toLowerCase().includes('free')) {
    return true;
  }

  return false;
};

/**
 * Get the user's preferred model for a provider from the shared store.
 * Returns the preferred model name if it exists in the available model list, otherwise undefined.
 */
const getPreferredModel = (providerName: string, availableModels: ModelInfo[]): string | undefined => {
  const preferred = preferredModelsStore.get();
  const preferredName = preferred[providerName];

  if (preferredName && availableModels.some((m) => m.name === preferredName && m.provider === providerName)) {
    return preferredName;
  }

  return undefined;
};

interface CombinedModelSelectorProps {
  model?: string;
  setModel?: (model: string) => void;
  provider?: ProviderInfo;
  setProvider?: (provider: ProviderInfo) => void;
  modelList: ModelInfo[];
  providerList: ProviderInfo[];
  apiKeys: Record<string, string>;
  modelLoading?: string;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  onOpenSettings?: (tab?: string) => void;
}

type DropdownSection = 'provider' | 'model';

export const CombinedModelSelector = ({
  model,
  setModel,
  provider,
  setProvider,
  modelList,
  providerList,
  apiKeys: _apiKeys,
  modelLoading,
  isOpen,
  onOpenChange,
  hideTrigger = false,
  onOpenSettings,
}: CombinedModelSelectorProps) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const envKeyStatus = useStore(envKeyStatusStore);

  // Use external control if provided, otherwise internal
  const isDropdownOpen = isOpen !== undefined ? isOpen : internalOpen;
  const setIsDropdownOpen = (open: boolean) => {
    if (onOpenChange) {
      onOpenChange(open);
    } else {
      setInternalOpen(open);
    }
  };

  // Disabled providers that have env keys configured on the server
  const envKeyDisabledProviders = useMemo(() => {
    const enabledNames = new Set(providerList.map((p) => p.name));

    return PROVIDER_LIST.filter((p) => {
      const status = envKeyStatus[p.name];
      return status?.hasEnvKey && !enabledNames.has(p.name);
    });
  }, [providerList, envKeyStatus]);

  const handleOpenSettings = useCallback(
    (tab?: string) => {
      setIsDropdownOpen(false);
      setSearchQuery('');
      onOpenSettings?.(tab);
    },
    [onOpenSettings],
  );

  const handleQuickEnable = useCallback(
    (p: ProviderInfo) => {
      updateProviderSettings(p.name, { enabled: true });
      setProvider?.(p);

      const preferred = getPreferredModel(p.name, modelList);
      const targetModel = preferred || modelList.find((m) => m.provider === p.name)?.name;

      if (targetModel) {
        setModel?.(targetModel);
      }

      setActiveSection('model');
      setSearchQuery('');
      setFocusedIndex(-1);
    },
    [modelList, setModel, setProvider],
  );

  const [activeSection, setActiveSection] = useState<DropdownSection>('provider');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [showFreeModelsOnly, setShowFreeModelsOnly] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionsRef = useRef<(HTMLDivElement | null)[]>([]);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 150);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Click outside handler
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
        setSearchQuery('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);

    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isDropdownOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isDropdownOpen, activeSection]);

  // Reset focused index when search changes
  useEffect(() => {
    setFocusedIndex(-1);
  }, [debouncedSearchQuery, activeSection, showFreeModelsOnly]);

  // Reset free models filter when provider changes
  useEffect(() => {
    setShowFreeModelsOnly(false);
  }, [provider?.name]);

  // Filter providers
  const filteredProviders = useMemo(() => {
    if (!debouncedSearchQuery) {
      return providerList;
    }

    return providerList
      .map((p) => {
        const match = fuzzyMatch(debouncedSearchQuery, p.name);
        return {
          ...p,
          searchScore: match.score,
          searchMatches: match.matches,
          highlightedName: highlightText(p.name, debouncedSearchQuery),
        };
      })
      .filter((p) => p.searchMatches)
      .sort((a, b) => b.searchScore - a.searchScore);
  }, [providerList, debouncedSearchQuery]);

  // Filter models
  const filteredModels = useMemo(() => {
    const baseModels = [...modelList].filter((e) => e.provider === provider?.name && e.name);

    return baseModels
      .filter((m) => {
        if (showFreeModelsOnly && !isModelLikelyFree(m, provider?.name)) {
          return false;
        }

        return true;
      })
      .map((m) => {
        const labelMatch = fuzzyMatch(debouncedSearchQuery, m.label);
        const nameMatch = fuzzyMatch(debouncedSearchQuery, m.name);
        const contextMatch = fuzzyMatch(debouncedSearchQuery, formatContextSize(m.maxTokenAllowed));

        const bestScore = Math.max(labelMatch.score, nameMatch.score, contextMatch.score);
        const matches = labelMatch.matches || nameMatch.matches || contextMatch.matches || !debouncedSearchQuery;

        return {
          ...m,
          searchScore: bestScore,
          searchMatches: matches,
          highlightedLabel: highlightText(m.label, debouncedSearchQuery),
          highlightedName: highlightText(m.name, debouncedSearchQuery),
        };
      })
      .filter((m) => m.searchMatches)
      .sort((a, b) => {
        if (debouncedSearchQuery) {
          return b.searchScore - a.searchScore;
        }

        return a.label.localeCompare(b.label);
      });
  }, [modelList, provider?.name, showFreeModelsOnly, debouncedSearchQuery]);

  const currentList = activeSection === 'provider' ? filteredProviders : filteredModels;

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setDebouncedSearchQuery('');

    if (searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!isDropdownOpen) {
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusedIndex((prev) => (prev + 1 >= currentList.length ? 0 : prev + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIndex((prev) => (prev - 1 < 0 ? currentList.length - 1 : prev - 1));
        break;
      case 'ArrowLeft':
        if (activeSection === 'model') {
          e.preventDefault();
          setActiveSection('provider');
          setSearchQuery('');
          setFocusedIndex(-1);
        }

        break;
      case 'ArrowRight':
        if (activeSection === 'provider') {
          e.preventDefault();
          setActiveSection('model');
          setSearchQuery('');
          setFocusedIndex(-1);
        }

        break;
      case 'Enter':
        e.preventDefault();

        if (focusedIndex >= 0 && focusedIndex < currentList.length) {
          if (activeSection === 'provider') {
            const selectedProvider = filteredProviders[focusedIndex] as ProviderInfo;
            setProvider?.(selectedProvider);

            const preferred = getPreferredModel(selectedProvider.name, modelList);
            const targetModel = preferred || modelList.find((m) => m.provider === selectedProvider.name)?.name;

            if (targetModel) {
              setModel?.(targetModel);
            }

            // Auto-switch to model selection after picking provider
            setActiveSection('model');
            setSearchQuery('');
            setFocusedIndex(-1);
          } else {
            const selectedModel = filteredModels[focusedIndex];
            setModel?.(selectedModel.name);

            // Sync preferred model to store so Settings CloudProviderCard stays in sync
            if (provider?.name) {
              updatePreferredModel(provider.name, selectedModel.name);
            }

            setIsDropdownOpen(false);
            setSearchQuery('');
          }
        }

        break;
      case 'Escape':
        e.preventDefault();
        setIsDropdownOpen(false);
        setSearchQuery('');
        break;
      case 'Tab':
        e.preventDefault();

        if (activeSection === 'provider') {
          setActiveSection('model');
        } else {
          setActiveSection('provider');
        }

        setSearchQuery('');
        setFocusedIndex(-1);
        break;
      case 'k':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          clearSearch();
        }

        break;
    }
  };

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex >= 0 && optionsRef.current[focusedIndex]) {
      optionsRef.current[focusedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [focusedIndex]);

  // Handle provider list validation
  useEffect(() => {
    if (providerList.length === 0) {
      return;
    }

    if (provider && !providerList.some((p) => p.name === provider.name)) {
      const firstEnabledProvider = providerList[0];
      setProvider?.(firstEnabledProvider);

      const preferred = getPreferredModel(firstEnabledProvider.name, modelList);
      const targetModel = preferred || modelList.find((m) => m.provider === firstEnabledProvider.name)?.name;

      if (targetModel) {
        setModel?.(targetModel);
      }
    }
  }, [providerList, provider, setProvider, modelList, setModel]);

  if (providerList.length === 0) {
    return (
      <div className="mb-2 p-4 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-prompt-background text-bolt-elements-textPrimary">
        <p className="text-center">
          No providers are currently enabled. Please enable at least one provider in the settings to start using the
          chat.
        </p>
      </div>
    );
  }

  const selectedModel = modelList.find((m) => m.name === model);

  return (
    <div className={cn('relative', hideTrigger ? '' : 'mb-2')} onKeyDown={handleKeyDown} ref={dropdownRef}>
      {/* Combined Pill Selector - Hidden when hideTrigger is true */}
      {!hideTrigger && (
        <div
          className={cn(
            'flex items-stretch rounded-full overflow-hidden cursor-pointer',
            'border border-white/8',
            'bg-[#1a2332]',
            'transition-all duration-200',
            'hover:border-[#4d6a8f]',
            isDropdownOpen ? 'ring-2 ring-[#4d6a8f]/50 border-[#4d6a8f]' : '',
          )}
          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
          role="combobox"
          aria-label="Select AI model"
          aria-expanded={isDropdownOpen}
          aria-haspopup="listbox"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setIsDropdownOpen(!isDropdownOpen);
            }
          }}
        >
          {/* Provider Section */}
          <div
            className={cn('flex items-center gap-2 px-4 py-2.5', 'bg-[#0b0d13]', 'border-r border-white/12')}
            onClick={(e) => {
              e.stopPropagation();
              setIsDropdownOpen(true);
              setActiveSection('provider');
            }}
          >
            <span className="i-ph:cube-duotone text-[#6b8bb8] text-lg" />
            <span className="text-sm font-medium text-[#e6edf3]">{provider?.name || 'Provider'}</span>
          </div>

          {/* Model Section */}
          <div
            className={cn('flex-1 flex items-center justify-between gap-2 px-4 py-2.5', 'min-w-0')}
            onClick={(e) => {
              e.stopPropagation();
              setIsDropdownOpen(true);
              setActiveSection('model');
            }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="i-ph:brain-duotone text-[#6b8bb8] text-lg flex-shrink-0" />
              <span className="text-sm text-[#e6edf3] truncate">{selectedModel?.label || 'Select model'}</span>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {modelLoading && <div className="i-svg-spinners:90-ring-with-bg text-[#6b8bb8] text-sm animate-spin" />}
              <span
                className={cn(
                  'i-ph:caret-down text-[#8b949e] transition-transform duration-200',
                  isDropdownOpen ? 'rotate-180' : '',
                )}
              />
            </div>
          </div>
        </div>
      )}

      {/* Dropdown Panel */}
      {isDropdownOpen && (
        <div
          className={cn(
            'z-50 w-full rounded-xl overflow-hidden',
            'border border-white/8',
            'bg-[#0b0d13]',
            'shadow-xl shadow-black/50',
            'max-h-[400px] flex flex-col',
          )}
        >
          {/* Section Tabs */}
          <div className="flex border-b border-white/8 bg-[#0b0d13]">
            <button
              type="button"
              className={cn(
                'flex-1 px-4 py-2.5 text-sm font-medium transition-all',
                'flex items-center justify-center gap-2',
                activeSection === 'provider'
                  ? 'bg-[#1e3a5f]/40 text-[#8badd4] border-b-2 border-[#4d6a8f]'
                  : 'bg-[#0b0d13] text-[#8b949e] hover:bg-[#1a2332] hover:text-[#e6edf3]',
              )}
              onClick={() => {
                setActiveSection('provider');
                setSearchQuery('');
                setFocusedIndex(-1);
              }}
            >
              <span className="i-ph:cube-duotone" />
              Provider
            </button>
            <button
              type="button"
              className={cn(
                'flex-1 px-4 py-2.5 text-sm font-medium transition-all',
                'flex items-center justify-center gap-2',
                activeSection === 'model'
                  ? 'bg-[#1e3a5f]/40 text-[#8badd4] border-b-2 border-[#4d6a8f]'
                  : 'bg-[#0b0d13] text-[#8b949e] hover:bg-[#1a2332] hover:text-[#e6edf3]',
              )}
              onClick={() => {
                setActiveSection('model');
                setSearchQuery('');
                setFocusedIndex(-1);
              }}
            >
              <span className="i-ph:brain-duotone" />
              Model
            </button>
            {/* Settings Shortcut */}
            {provider && (
              <div className="flex items-center px-2">
                <button
                  type="button"
                  className="flex items-center justify-center w-8 h-8 rounded-md text-[#6e7681] hover:text-[#e6edf3] hover:bg-[#1a2332] transition-colors"
                  title="Open Cloud Providers settings"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenSettings('cloud-providers');
                  }}
                >
                  <div className="i-ph:gear-six text-base" />
                </button>
              </div>
            )}
          </div>

          {/* Search Input */}
          <div className="p-3 border-b border-white/[0.04]">
            <div className="relative">
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={`Search ${activeSection === 'provider' ? 'providers' : 'models'}... (⌘K to clear)`}
                className={cn(
                  'w-full pl-9 pr-9 py-2 rounded-lg text-sm',
                  'bg-[#1a2332] border border-white/8',
                  'text-[#e6edf3] placeholder:text-[#6e7681]',
                  'focus:outline-none focus:ring-2 focus:ring-[#4d6a8f]/50 focus:border-[#4d6a8f]',
                  'transition-all',
                )}
                onClick={(e) => e.stopPropagation()}
                role="searchbox"
                aria-label={`Search ${activeSection}`}
              />
              <div className="absolute left-3 top-1/2 -translate-y-1/2">
                <span className="i-ph:magnifying-glass text-[#6e7681]" />
              </div>
              {searchQuery && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    clearSearch();
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-[#2a2a2a] transition-colors"
                  aria-label="Clear search"
                >
                  <span className="i-ph:x text-[#6e7681] text-sm" />
                </button>
              )}
            </div>

            {/* Free Models Filter - Only for OpenRouter in model section */}
            {activeSection === 'model' && provider?.name === 'OpenRouter' && (
              <div className="flex items-center gap-2 mt-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowFreeModelsOnly(!showFreeModelsOnly);
                  }}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all',
                    showFreeModelsOnly
                      ? 'bg-[#1e3a5f]/30 text-[#8badd4] border border-[#4d6a8f]/30'
                      : 'bg-[#1a2332] text-[#8b949e] border border-white/8 hover:border-[#4d6a8f]/30',
                  )}
                >
                  <span className="i-ph:gift" />
                  Free models only
                </button>
                {showFreeModelsOnly && (
                  <span className="text-xs text-[#6e7681]">
                    {filteredModels.length} free model{filteredModels.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            )}

            {/* Search Result Count */}
            {debouncedSearchQuery && currentList.length > 0 && (
              <div className="text-xs text-[#6e7681] mt-2">
                {currentList.length} {activeSection}
                {currentList.length !== 1 ? 's' : ''} found
              </div>
            )}
          </div>

          {/* Options List */}
          <div
            className={cn(
              'flex-1 overflow-y-auto',
              '[&::-webkit-scrollbar]:w-1.5',
              '[&::-webkit-scrollbar-thumb]:bg-white/10',
              '[&::-webkit-scrollbar-thumb]:hover:bg-[#4d6a8f]/50',
              '[&::-webkit-scrollbar-thumb]:rounded-full',
              '[&::-webkit-scrollbar-track]:bg-transparent',
            )}
          >
            {currentList.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <div className="text-[#6e7681] text-sm mb-1">
                  {debouncedSearchQuery
                    ? `No ${activeSection}s match "${debouncedSearchQuery}"`
                    : `No ${activeSection}s found`}
                </div>
                {debouncedSearchQuery && <div className="text-xs text-[#6e7681]">Try a different search term</div>}
              </div>
            ) : activeSection === 'provider' ? (
              <>
                {filteredProviders.map((p, index) => (
                  <div
                    ref={(el) => {
                      optionsRef.current[index] = el;
                    }}
                    key={p.name}
                    role="option"
                    aria-selected={provider?.name === p.name}
                    className={cn(
                      'px-4 py-3 cursor-pointer transition-all',
                      'flex items-center gap-3',
                      provider?.name === p.name
                        ? 'bg-[#1e3a5f]/20 text-[#8badd4]'
                        : 'text-[#e6edf3] hover:bg-[#1a2332]',
                      focusedIndex === index ? 'ring-1 ring-inset ring-[#4d6a8f]/50 bg-[#1a2332]' : '',
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      setProvider?.(p);

                      const preferred = getPreferredModel(p.name, modelList);
                      const targetModel = preferred || modelList.find((m) => m.provider === p.name)?.name;

                      if (targetModel) {
                        setModel?.(targetModel);
                      }

                      setActiveSection('model');
                      setSearchQuery('');
                      setFocusedIndex(-1);
                    }}
                    tabIndex={focusedIndex === index ? 0 : -1}
                  >
                    <span className="i-ph:cube text-lg" />
                    <span
                      className="text-sm"
                      dangerouslySetInnerHTML={{
                        __html: (p as { highlightedName?: string }).highlightedName || p.name,
                      }}
                    />
                    {provider?.name === p.name && <span className="i-ph:check ml-auto text-[#8badd4]" />}
                  </div>
                ))}
                {/* Quick-enable: disabled providers that have server env keys */}
                {!debouncedSearchQuery && envKeyDisabledProviders.length > 0 && (
                  <>
                    <div className="px-4 py-2 border-t border-white/[0.06]">
                      <span className="text-xs text-[#6e7681]">Available via env key</span>
                    </div>
                    {envKeyDisabledProviders.map((ep) => (
                      <div key={`env-${ep.name}`} className="px-4 py-3 flex items-center gap-3 text-[#6e7681]">
                        <span className="relative flex-shrink-0">
                          <span className="i-ph:cube text-lg" />
                          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500" />
                        </span>
                        <span className="text-sm flex-1">{ep.name}</span>
                        <button
                          type="button"
                          className="px-2.5 py-1 rounded-md text-xs font-medium bg-[#1e3a5f]/40 text-[#8badd4] hover:bg-[#1e3a5f]/70 transition-colors"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleQuickEnable(ep as unknown as ProviderInfo);
                          }}
                        >
                          Enable
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </>
            ) : (
              filteredModels.map((m, index) => (
                <div
                  ref={(el) => {
                    optionsRef.current[index] = el;
                  }}
                  key={m.name}
                  role="option"
                  aria-selected={model === m.name}
                  className={cn(
                    'px-4 py-3 cursor-pointer transition-all',
                    model === m.name ? 'bg-[#1e3a5f]/20 text-[#8badd4]' : 'text-[#e6edf3] hover:bg-[#1a2332]',
                    focusedIndex === index ? 'ring-1 ring-inset ring-[#4d6a8f]/50 bg-[#1a2332]' : '',
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    setModel?.(m.name);

                    // Sync preferred model to store so Settings CloudProviderCard stays in sync
                    if (provider?.name) {
                      updatePreferredModel(provider.name, m.name);
                    }

                    setIsDropdownOpen(false);
                    setSearchQuery('');
                  }}
                  tabIndex={focusedIndex === index ? 0 : -1}
                >
                  <div className="flex items-center gap-3">
                    <span className="i-ph:brain text-lg flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div
                        className="text-sm truncate"
                        dangerouslySetInnerHTML={{
                          __html: (m as { highlightedLabel?: string }).highlightedLabel || m.label,
                        }}
                      />
                      {m.maxTokenAllowed > 0 && (
                        <div className="text-xs text-[#6e7681] mt-0.5">
                          {formatContextSize(m.maxTokenAllowed)} context
                        </div>
                      )}
                    </div>
                    {isModelLikelyFree(m, provider?.name) && (
                      <span className="px-1.5 py-0.5 rounded text-xs bg-green-500/20 text-green-400 flex-shrink-0">
                        Free
                      </span>
                    )}
                    {model === m.name && <span className="i-ph:check text-[#8badd4] flex-shrink-0" />}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer Hint */}
          <div className="px-4 py-2 border-t border-white/[0.04] bg-[#0b0d13]">
            <div className="flex items-center justify-between text-xs text-[#6e7681]">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-[#1a2332] border border-white/8">↑↓</kbd>
                  navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-[#1a2332] border border-white/8">Tab</kbd>
                  switch
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-[#1a2332] border border-white/8">↵</kbd>
                  select
                </span>
              </div>
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 rounded bg-[#1a2332] border border-white/8">Esc</kbd>
                close
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
