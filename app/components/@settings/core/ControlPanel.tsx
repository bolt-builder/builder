import { useState, useEffect, useMemo, lazy, Suspense, useCallback } from 'react';
import { useStore } from '@nanostores/react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { useFeatures } from '~/lib/hooks/useFeatures';
import { useNotifications } from '~/lib/hooks/useNotifications';
import { useConnectionStatus } from '~/lib/hooks/useConnectionStatus';
import { tabConfigurationStore, resetTabConfiguration } from '~/lib/stores/settings';
import { profileStore } from '~/lib/stores/profile';
import type { TabType, Profile } from './types';
import { TAB_LABELS, TAB_ICONS, TAB_DESCRIPTIONS, TAB_KEYWORDS, SIDEBAR_CATEGORIES } from './constants';
import { DialogTitle } from '~/components/ui/Dialog';
import { cn } from '~/utils/cn';
import { createScopedLogger } from '~/utils/logger';
import { PanelErrorBoundary } from '~/components/ui/PanelErrorBoundary';

const logger = createScopedLogger('ControlPanel');

// Lazy load all tab components for better initial performance
const ProfileTab = lazy(() => import('~/components/@settings/tabs/profile/ProfileTab'));
const SettingsTab = lazy(() => import('~/components/@settings/tabs/settings/SettingsTab'));
const NotificationsTab = lazy(() => import('~/components/@settings/tabs/notifications/NotificationsTab'));
const FeaturesTab = lazy(() => import('~/components/@settings/tabs/features/FeaturesTab'));
const DataTab = lazy(() => import('~/components/@settings/tabs/data/DataTab').then((m) => ({ default: m.DataTab })));
const EventLogsTab = lazy(() =>
  import('~/components/@settings/tabs/event-logs/EventLogsTab').then((m) => ({ default: m.EventLogsTab })),
);
const GitHubTab = lazy(() => import('~/components/@settings/tabs/github/GitHubTab'));
const GitLabTab = lazy(() => import('~/components/@settings/tabs/gitlab/GitLabTab'));
const SupabaseTab = lazy(() => import('~/components/@settings/tabs/supabase/SupabaseTab'));
const VercelTab = lazy(() => import('~/components/@settings/tabs/vercel/VercelTab'));
const NetlifyTab = lazy(() => import('~/components/@settings/tabs/netlify/NetlifyTab'));
const CloudProvidersTab = lazy(() => import('~/components/@settings/tabs/providers/cloud/CloudProvidersTab'));
const LocalProvidersTab = lazy(() => import('~/components/@settings/tabs/providers/local/LocalProvidersTab'));
const McpTab = lazy(() => import('~/components/@settings/tabs/mcp/McpTab'));
const ProjectMemoryTab = lazy(() => import('~/components/@settings/tabs/project-memory/ProjectMemoryTab'));

// Loading fallback for lazy-loaded tabs
const TabLoadingFallback = () => (
  <div className="flex items-center justify-center h-64">
    <div className="animate-spin w-8 h-8 border-2 border-devonz-elements-item-contentAccent border-t-transparent rounded-full" />
  </div>
);

interface ControlPanelProps {
  open: boolean;
  onClose: () => void;
  initialTab?: TabType;
}

// Beta status for experimental features
const BETA_TABS = new Set<TabType>(['local-providers', 'mcp']);

/** Does a tab match the sidebar search query? Checks label, description, and keywords. */
function tabMatchesQuery(tabId: TabType, normalizedQuery: string): boolean {
  if (TAB_LABELS[tabId].toLowerCase().includes(normalizedQuery)) {
    return true;
  }

  if (TAB_DESCRIPTIONS[tabId]?.toLowerCase().includes(normalizedQuery)) {
    return true;
  }

  return (TAB_KEYWORDS[tabId] ?? []).some((keyword) => keyword.includes(normalizedQuery));
}

export const ControlPanel = ({ open, onClose, initialTab }: ControlPanelProps) => {
  // State
  const [activeTab, setActiveTab] = useState<TabType | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Store values
  const tabConfiguration = useStore(tabConfigurationStore);
  const profile = useStore(profileStore) as Profile;

  // Status hooks
  const { hasNewFeatures, acknowledgeAllFeatures } = useFeatures();
  const { hasUnreadNotifications, markAllAsRead } = useNotifications();
  const { hasConnectionIssues, acknowledgeIssue } = useConnectionStatus();

  // Add visibleTabs logic using useMemo with optimized calculations
  const visibleTabs = useMemo(() => {
    if (!tabConfiguration?.userTabs || !Array.isArray(tabConfiguration.userTabs)) {
      logger.warn('Invalid tab configuration, resetting to defaults');
      resetTabConfiguration();

      return [];
    }

    const notificationsDisabled = profile?.preferences?.notifications === false;

    // Optimize user mode tab filtering
    return tabConfiguration.userTabs
      .filter((tab) => {
        if (!tab?.id) {
          return false;
        }

        if (tab.id === 'notifications' && notificationsDisabled) {
          return false;
        }

        return tab.visible && tab.window === 'user';
      })
      .sort((a, b) => a.order - b.order);
  }, [tabConfiguration, profile?.preferences?.notifications]);

  // Build categorized tab list from visible tabs (unfiltered — used for default-tab selection)
  const allCategorizedTabs = useMemo(() => {
    const visibleTabIds = new Set(visibleTabs.map((t) => t.id));

    return SIDEBAR_CATEGORIES.map((category) => ({
      ...category,
      tabs: category.tabs.filter((tabId) => visibleTabIds.has(tabId)),
    })).filter((category) => category.tabs.length > 0);
  }, [visibleTabs]);

  // Apply the sidebar search filter (category label matches keep the whole category)
  const categorizedTabs = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return allCategorizedTabs;
    }

    return allCategorizedTabs
      .map((category) => ({
        ...category,
        tabs: category.label.toLowerCase().includes(normalizedQuery)
          ? category.tabs
          : category.tabs.filter((tabId) => tabMatchesQuery(tabId, normalizedQuery)),
      }))
      .filter((category) => category.tabs.length > 0);
  }, [allCategorizedTabs, searchQuery]);

  // Flat list of visible (filtered) tab IDs for keyboard navigation
  const flatTabIds = useMemo(() => categorizedTabs.flatMap((cat) => cat.tabs), [categorizedTabs]);

  // First tab overall — the default selection when no initialTab is given (VS Code style)
  const defaultTabId = allCategorizedTabs[0]?.tabs[0] ?? null;

  // Reset to default view when modal opens/closes
  useEffect(() => {
    if (open) {
      setActiveTab((prev) => prev ?? initialTab ?? defaultTabId);
    } else {
      setActiveTab(null);
    }

    setSearchQuery('');
  }, [open, initialTab, defaultTabId]);

  // Handle closing
  const handleClose = useCallback(() => {
    setActiveTab(null);
    onClose();
  }, [onClose]);

  const getTabComponent = useCallback((tabId: TabType) => {
    const tabComponents: Record<TabType, React.ReactNode> = {
      profile: <ProfileTab />,
      settings: <SettingsTab />,
      notifications: <NotificationsTab />,
      features: <FeaturesTab />,
      data: <DataTab />,
      'cloud-providers': <CloudProvidersTab />,
      'local-providers': <LocalProvidersTab />,
      github: <GitHubTab />,
      gitlab: <GitLabTab />,
      supabase: <SupabaseTab />,
      vercel: <VercelTab />,
      netlify: <NetlifyTab />,
      'event-logs': <EventLogsTab />,
      mcp: <McpTab />,
      'project-memory': <ProjectMemoryTab />,
    };

    return (
      <PanelErrorBoundary panelName={`settings-${tabId}`}>
        <Suspense fallback={<TabLoadingFallback />}>{tabComponents[tabId] || null}</Suspense>
      </PanelErrorBoundary>
    );
  }, []);

  const getTabUpdateStatus = (tabId: TabType): boolean => {
    switch (tabId) {
      case 'features':
        return hasNewFeatures;
      case 'notifications':
        return hasUnreadNotifications;
      case 'github':
      case 'gitlab':
      case 'supabase':
      case 'vercel':
      case 'netlify':
        return hasConnectionIssues;
      default:
        return false;
    }
  };

  const handleTabClick = (tabId: TabType) => {
    setActiveTab(tabId);

    // Acknowledge notifications based on tab
    switch (tabId) {
      case 'features':
        acknowledgeAllFeatures();
        break;
      case 'notifications':
        markAllAsRead();
        break;
      case 'github':
      case 'gitlab':
      case 'supabase':
      case 'vercel':
      case 'netlify':
        acknowledgeIssue();
        break;
    }
  };

  // Handle keyboard navigation between tabs
  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent, tabId: TabType) => {
      const currentIndex = flatTabIds.indexOf(tabId);

      if (currentIndex === -1) {
        return;
      }

      let nextIndex = -1;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        nextIndex = (currentIndex + 1) % flatTabIds.length;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        nextIndex = (currentIndex - 1 + flatTabIds.length) % flatTabIds.length;
      } else if (e.key === 'Home') {
        e.preventDefault();
        nextIndex = 0;
      } else if (e.key === 'End') {
        e.preventDefault();
        nextIndex = flatTabIds.length - 1;
      }

      if (nextIndex >= 0) {
        const nextTabId = flatTabIds[nextIndex];
        handleTabClick(nextTabId);

        const nextButton = document.querySelector(`[data-tab-id="${nextTabId}"]`) as HTMLElement;
        nextButton?.focus();
      }
    },
    [flatTabIds, handleTabClick],
  );

  return (
    <RadixDialog.Root open={open}>
      <RadixDialog.Portal>
        <div className="fixed inset-0 flex items-center justify-center z-[100]">
          <RadixDialog.Overlay className="absolute inset-0 bg-black/80" onClick={handleClose} />

          <RadixDialog.Content
            aria-describedby={undefined}
            onEscapeKeyDown={(event) => {
              // First Escape clears an active search; second closes the panel
              if (searchQuery) {
                event.preventDefault();
                setSearchQuery('');

                return;
              }

              handleClose();
            }}
            className="dark relative z-[101] w-[min(1200px,96vw)] h-[92vh] rounded-xl shadow-2xl border border-devonz-elements-borderColor flex overflow-hidden"
            style={{ backgroundColor: 'var(--devonz-elements-bg-depth-1)' }}
          >
            {/* Sidebar */}
            <div
              className="w-60 border-r border-devonz-elements-borderColor flex flex-col"
              style={{ backgroundColor: 'var(--devonz-elements-bg-depth-1)' }}
            >
              {/* Header */}
              <div className="px-4 pt-4 pb-3 border-b border-devonz-elements-borderColor flex flex-col gap-3">
                <h2 className="text-sm font-semibold text-devonz-elements-textPrimary">Settings</h2>
                <div className="relative">
                  <div className="i-ph:magnifying-glass w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-devonz-elements-textTertiary pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && flatTabIds.length > 0) {
                        e.preventDefault();
                        handleTabClick(flatTabIds[0]);
                      }
                    }}
                    placeholder="Search settings..."
                    aria-label="Search settings"
                    className={cn(
                      'w-full pl-8 pr-2.5 py-1.5 text-xs rounded-md',
                      'border border-devonz-elements-borderColor',
                      'text-devonz-elements-textPrimary placeholder-devonz-elements-textTertiary',
                      'focus:outline-none focus:ring-1 focus:ring-devonz-elements-focus',
                      'transition-colors duration-150',
                    )}
                    style={{ backgroundColor: 'var(--devonz-elements-bg-depth-3)' }}
                  />
                </div>
              </div>

              {/* Categorized Nav */}
              <nav
                className="flex-1 overflow-y-auto py-2"
                role="tablist"
                aria-label="Settings"
                aria-orientation="vertical"
              >
                {categorizedTabs.length === 0 && (
                  <div className="px-4 py-6 text-center">
                    <div className="i-ph:magnifying-glass w-5 h-5 mx-auto mb-2 text-devonz-elements-textTertiary" />
                    <p className="text-xs text-devonz-elements-textSecondary">
                      No settings match &ldquo;{searchQuery}&rdquo;
                    </p>
                  </div>
                )}
                {categorizedTabs.map((category, catIndex) => (
                  <div key={category.id} className={cn(catIndex > 0 ? 'mt-3' : '')}>
                    {/* Category Header */}
                    <div className="flex items-center gap-2 px-4 py-1.5 mb-0.5">
                      <div className={cn(category.icon, 'w-3.5 h-3.5 text-devonz-elements-textTertiary')} />
                      <span className="text-[11px] font-medium uppercase tracking-wider text-devonz-elements-textTertiary">
                        {category.label}
                      </span>
                    </div>

                    {/* Tab Buttons in Category */}
                    {category.tabs.map((tabId) => {
                      const IconComponent = TAB_ICONS[tabId];
                      const hasUpdate = getTabUpdateStatus(tabId);
                      const isActive = activeTab === tabId;

                      return (
                        <button
                          key={tabId}
                          data-tab-id={tabId}
                          role="tab"
                          aria-selected={isActive}
                          aria-controls={`tabpanel-${tabId}`}
                          id={`tab-${tabId}`}
                          tabIndex={isActive ? 0 : -1}
                          onClick={() => handleTabClick(tabId)}
                          onKeyDown={(e) => handleTabKeyDown(e, tabId)}
                          className={cn(
                            'w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors duration-150',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-devonz-elements-focus focus-visible:ring-inset',
                            isActive
                              ? 'text-devonz-elements-textPrimary border-l-2 border-devonz-elements-item-contentAccent'
                              : 'text-devonz-elements-textSecondary hover:text-devonz-elements-textPrimary border-l-2 border-transparent',
                          )}
                          style={{
                            backgroundColor: isActive ? 'var(--devonz-elements-bg-depth-3)' : 'transparent',
                            paddingLeft: isActive ? '14px' : '16px',
                          }}
                        >
                          <IconComponent className="w-4 h-4 shrink-0" />
                          <span className="truncate">{TAB_LABELS[tabId]}</span>
                          {hasUpdate && (
                            <span className="ml-auto w-2 h-2 rounded-full bg-devonz-elements-item-contentAccent shrink-0" />
                          )}
                          {BETA_TABS.has(tabId) && (
                            <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-devonz-elements-item-backgroundAccent text-devonz-elements-item-contentAccent shrink-0">
                              BETA
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </nav>
            </div>

            {/* Main Content */}
            <div
              className="flex-1 flex flex-col min-w-0"
              style={{ backgroundColor: 'var(--devonz-elements-bg-depth-1)' }}
            >
              {/* Content Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-devonz-elements-borderColor">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <DialogTitle className="text-sm font-semibold text-devonz-elements-textPrimary">
                    {activeTab ? TAB_LABELS[activeTab] : 'Settings'}
                  </DialogTitle>
                  {activeTab && TAB_DESCRIPTIONS[activeTab] && (
                    <p className="text-xs text-devonz-elements-textTertiary truncate">{TAB_DESCRIPTIONS[activeTab]}</p>
                  )}
                </div>
                <button
                  onClick={handleClose}
                  aria-label="Close settings"
                  className="p-1.5 rounded transition-colors hover:bg-devonz-elements-bg-depth-4"
                  style={{ backgroundColor: 'var(--devonz-elements-bg-depth-3)' }}
                >
                  <div className="i-ph:x w-4 h-4 text-devonz-elements-textSecondary" />
                </button>
              </div>

              {/* Tab Content */}
              <div
                className="flex-1 overflow-y-auto p-6"
                role="tabpanel"
                id={activeTab ? `tabpanel-${activeTab}` : undefined}
                aria-labelledby={activeTab ? `tab-${activeTab}` : undefined}
              >
                {activeTab ? (
                  getTabComponent(activeTab)
                ) : (
                  <div className="flex flex-col items-center justify-center h-full gap-6">
                    <div className="i-ph:gear w-12 h-12 text-devonz-elements-textTertiary" />
                    <div className="text-center">
                      <p className="text-sm text-devonz-elements-textSecondary mb-1">
                        Select a setting from the sidebar
                      </p>
                      <p className="text-xs text-devonz-elements-textTertiary">
                        Configure providers, services, and preferences
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-center gap-2 max-w-md">
                      {categorizedTabs.slice(0, 3).flatMap((cat) =>
                        cat.tabs.slice(0, 2).map((tabId) => {
                          const IconComponent = TAB_ICONS[tabId];

                          return (
                            <button
                              key={tabId}
                              onClick={() => handleTabClick(tabId)}
                              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-devonz-elements-textSecondary transition-colors hover:text-devonz-elements-textPrimary"
                              style={{ backgroundColor: 'var(--devonz-elements-bg-depth-3)' }}
                            >
                              <IconComponent className="w-3.5 h-3.5" />
                              {TAB_LABELS[tabId]}
                            </button>
                          );
                        }),
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </RadixDialog.Content>
        </div>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
};
