import { Switch } from '~/components/ui/Switch';
import { Card, CardContent } from '~/components/ui/Card';
import { cn } from '~/utils/cn';
import type { IProviderConfig } from '~/types/model';
import { PROVIDER_DESCRIPTIONS } from './types';

// Provider Card Component
interface ProviderCardProps {
  provider: IProviderConfig;
  onToggle: (enabled: boolean) => void;
  onUpdateBaseUrl: (url: string) => void;
  isEditing: boolean;
  onStartEditing: () => void;
  onStopEditing: () => void;
}

function ProviderCard({
  provider,
  onToggle,
  onUpdateBaseUrl,
  isEditing,
  onStartEditing,
  onStopEditing,
}: ProviderCardProps) {
  const getIconClass = (providerName: string) => {
    switch (providerName) {
      case 'Ollama':
        return 'i-ph:hard-drive';
      case 'LMStudio':
        return 'i-ph:monitor';
      case 'OpenAILike':
        return 'i-ph:globe';
      default:
        return 'i-ph:hard-drive';
    }
  };

  const iconClass = getIconClass(provider.name);

  return (
    <Card
      className="w-full transition-all duration-300 shadow-sm hover:shadow-md"
      style={{
        backgroundColor: 'var(--bolt-elements-bg-depth-1)',
        borderColor: provider.settings.enabled ? 'rgba(139, 92, 246, 0.3)' : 'var(--bolt-elements-borderColor)',
      }}
    >
      <CardContent className="!p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 flex-1">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 transition-all duration-300"
              style={{
                backgroundColor: provider.settings.enabled
                  ? 'rgba(139, 92, 246, 0.1)'
                  : 'var(--bolt-elements-bg-depth-3)',
                boxShadow: provider.settings.enabled ? '0 0 0 1px rgba(139, 92, 246, 0.3)' : 'none',
              }}
            >
              <div
                className={cn(iconClass, 'w-5 h-5 transition-all duration-300')}
                style={{ color: provider.settings.enabled ? '#a855f7' : '#6b7280' }}
              />
            </div>
            <div className="flex-1 flex flex-col justify-center">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-white">{provider.name}</h3>
                <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/10 text-green-500 font-medium">
                  Local
                </span>
              </div>
              <p className="text-sm text-gray-400">
                {PROVIDER_DESCRIPTIONS[provider.name as keyof typeof PROVIDER_DESCRIPTIONS]}
              </p>

              {provider.settings.enabled && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">API Endpoint</label>
                  {isEditing ? (
                    <input
                      type="text"
                      inputMode="url"
                      autoComplete="url"
                      spellCheck={false}
                      defaultValue={provider.settings.baseUrl}
                      placeholder={`Enter ${provider.name} base URL`}
                      className="w-full px-4 py-3 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-bolt-elements-borderColorActive transition-all duration-200 shadow-sm"
                      style={{
                        backgroundColor: 'var(--bolt-elements-bg-depth-3)',
                        borderColor: 'rgba(6, 182, 212, 0.3)',
                        border: '1px solid rgba(6, 182, 212, 0.3)',
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          onUpdateBaseUrl(e.currentTarget.value);
                          onStopEditing();
                        } else if (e.key === 'Escape') {
                          onStopEditing();
                        }
                      }}
                      onBlur={(e) => {
                        onUpdateBaseUrl(e.target.value);
                        onStopEditing();
                      }}
                      autoFocus
                    />
                  ) : (
                    <button
                      onClick={onStartEditing}
                      className="w-full px-4 py-3 rounded-lg text-sm hover:shadow-sm transition-all duration-200 text-left group"
                      style={{
                        backgroundColor: 'var(--bolt-elements-bg-depth-3)',
                        border: '1px solid var(--bolt-elements-borderColor)',
                      }}
                    >
                      <div className="flex items-center gap-3 text-gray-400 group-hover:text-white">
                        <div className="i-ph:link w-4 h-4 group-hover:text-bolt-elements-item-contentAccent transition-colors" />
                        <span className="font-mono">{provider.settings.baseUrl || 'Click to set base URL'}</span>
                      </div>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          <Switch
            checked={provider.settings.enabled}
            onCheckedChange={onToggle}
            aria-label={`Toggle ${provider.name} provider`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default ProviderCard;
