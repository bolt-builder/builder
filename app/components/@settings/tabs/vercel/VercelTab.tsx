import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { useStore } from '@nanostores/react';
import { logStore } from '~/lib/stores/logs';
import { vercelApi } from '~/lib/api/vercel-client';
import type { VercelUserResponse } from '~/types/vercel';
import { cn } from '~/utils/cn';
import { Button } from '~/components/ui/Button';
import { ServiceHeader, ConnectionTestIndicator } from '~/components/@settings/shared/service-integration';
import { useConnectionTest } from '~/lib/hooks';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '~/components/ui/Collapsible';
import Cookies from 'js-cookie';
import {
  vercelConnection,
  isConnecting,
  isFetchingStats,
  updateVercelConnection,
  fetchVercelStats,
  fetchVercelStatsViaAPI,
  initializeVercelConnection,
} from '~/lib/stores/vercel';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('VercelTab');

interface ProjectAction {
  name: string;
  icon: string;
  action: (projectId: string) => Promise<void>;
  requiresConfirmation?: boolean;
  variant?: 'default' | 'destructive' | 'outline';
}

// Vercel logo SVG component
const VercelLogo = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5">
    <path fill="currentColor" d="m12 2 10 18H2z" />
  </svg>
);

export default function VercelTab() {
  const connection = useStore(vercelConnection);
  const connecting = useStore(isConnecting);
  const fetchingStats = useStore(isFetchingStats);
  const [isProjectsExpanded, setIsProjectsExpanded] = useState(false);
  const [isProjectActionLoading, setIsProjectActionLoading] = useState(false);

  // Use shared connection test hook
  const {
    testResult: connectionTest,
    testConnection,
    isTestingConnection,
  } = useConnectionTest({
    testEndpoint: '/api/vercel-user',
    serviceName: 'Vercel',
    getUserIdentifier: (data: unknown) => {
      const d = data as VercelUserResponse;
      return d.username || d.user?.username || d.email || d.user?.email || 'Vercel User';
    },
    getToken: () => vercelConnection.get().token || null,
  });

  // Memoize project actions to prevent unnecessary re-renders
  const projectActions: ProjectAction[] = useMemo(
    () => [
      {
        name: 'Redeploy',
        icon: 'i-ph:arrows-clockwise',
        action: async (projectId: string) => {
          try {
            const result = await vercelApi.post<{ id: string }>('/v1/deployments', connection.token, {
              name: projectId,
              target: 'production',
            });

            if (!result.success) {
              throw new Error(result.error || 'Failed to redeploy project');
            }

            toast.success('Project redeployment initiated');
            await fetchVercelStats(connection.token);
          } catch (err: unknown) {
            const error = err instanceof Error ? err.message : 'Unknown error';
            toast.error(`Failed to redeploy project: ${error}`);
          }
        },
      },
      {
        name: 'View Dashboard',
        icon: 'i-ph:layout',
        action: async (projectId: string) => {
          window.open(`https://vercel.com/dashboard/${projectId}`, '_blank', 'noopener,noreferrer');
        },
      },
      {
        name: 'Delete Project',
        icon: 'i-ph:trash',
        action: async (projectId: string) => {
          try {
            const result = await vercelApi.delete(`/v1/projects/${projectId}`, connection.token);

            if (!result.success) {
              throw new Error(result.error || 'Failed to delete project');
            }

            toast.success('Project deleted successfully');
            await fetchVercelStats(connection.token);
          } catch (err: unknown) {
            const error = err instanceof Error ? err.message : 'Unknown error';
            toast.error(`Failed to delete project: ${error}`);
          }
        },
        requiresConfirmation: true,
        variant: 'destructive',
      },
    ],
    [connection.token],
  ); // Only re-create when token changes

  // Initialize connection on component mount - check server-side token first
  useEffect(() => {
    const initializeConnection = async () => {
      try {
        // First try to initialize using server-side token
        await initializeVercelConnection();

        // If no connection was established, the user will need to manually enter a token
        const currentState = vercelConnection.get();

        if (!currentState.user) {
          logger.debug('No server-side Vercel token available, manual connection required');
        }
      } catch (error) {
        logger.error('Failed to initialize Vercel connection:', error);
      }
    };
    initializeConnection();
  }, []);

  useEffect(() => {
    const fetchProjects = async () => {
      if (connection.user) {
        // Use server-side API if we have a connected user
        try {
          await fetchVercelStatsViaAPI(connection.token);
        } catch {
          // Fallback to direct API if server-side fails and we have a token
          if (connection.token) {
            await fetchVercelStats(connection.token);
          }
        }
      }
    };
    fetchProjects();
  }, [connection.user, connection.token]);

  const handleConnect = async (event: React.FormEvent) => {
    event.preventDefault();
    isConnecting.set(true);

    try {
      const token = connection.token;

      if (!token.trim()) {
        throw new Error('Token is required');
      }

      // Test the token via proxy (bypasses CORS)
      const result = await vercelApi.testConnection(token);

      if (!result.success || !result.data) {
        throw new Error(result.error || 'Invalid Vercel token');
      }

      const userData = result.data as VercelUserResponse;

      // Set cookies for server-side API access
      Cookies.set('VITE_VERCEL_ACCESS_TOKEN', token, { expires: 365 });

      // Normalize the user data structure
      const normalizedUser = userData.user || {
        id: userData.id || '',
        username: userData.username || '',
        email: userData.email || '',
        name: userData.name || '',
        avatar: userData.avatar,
      };

      updateVercelConnection({
        user: normalizedUser,
        token,
      });

      await fetchVercelStats(token);
      toast.success('Successfully connected to Vercel');
    } catch (error) {
      logger.error('Auth error:', error);
      logStore.logError('Failed to authenticate with Vercel', { error });

      const errorMessage = error instanceof Error ? error.message : 'Failed to connect to Vercel';
      toast.error(errorMessage);
      updateVercelConnection({ user: null, token: '' });
    } finally {
      isConnecting.set(false);
    }
  };

  const handleDisconnect = () => {
    // Clear Vercel-related cookies
    Cookies.remove('VITE_VERCEL_ACCESS_TOKEN');

    updateVercelConnection({ user: null, token: '' });
    toast.success('Disconnected from Vercel');
  };

  const handleProjectAction = useCallback(async (projectId: string, action: ProjectAction) => {
    if (action.requiresConfirmation) {
      if (!confirm(`Are you sure you want to ${action.name.toLowerCase()}?`)) {
        return;
      }
    }

    setIsProjectActionLoading(true);

    try {
      await action.action(projectId);
    } catch {
      toast.error(`Failed to ${action.name.toLowerCase()}`);
    } finally {
      setIsProjectActionLoading(false);
    }
  }, []);

  const renderProjects = useCallback(() => {
    if (fetchingStats) {
      return (
        <div className="flex items-center gap-2 text-sm text-bolt-elements-textSecondary">
          <div className="i-ph:spinner-gap w-4 h-4 animate-spin" />
          Fetching Vercel projects...
        </div>
      );
    }

    return (
      <Collapsible open={isProjectsExpanded} onOpenChange={setIsProjectsExpanded}>
        <CollapsibleTrigger asChild>
          <div className="flex items-center justify-between p-4 rounded-lg bg-bolt-elements-background dark:bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor hover:border-bolt-elements-borderColorActive/70 dark:hover:border-bolt-elements-borderColorActive/70 transition-all duration-200 cursor-pointer">
            <div className="flex items-center gap-2">
              <div className="i-ph:buildings w-4 h-4 text-bolt-elements-item-contentAccent" />
              <span className="text-sm font-medium text-bolt-elements-textPrimary">
                Your Projects ({connection.stats?.totalProjects || 0})
              </span>
            </div>
            <div
              className={cn(
                'i-ph:caret-down w-4 h-4 transform transition-transform duration-200 text-bolt-elements-textSecondary',
                isProjectsExpanded ? 'rotate-180' : '',
              )}
            />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden">
          <div className="space-y-4 mt-4">
            {/* Consolidated Overview */}
            {connection.stats?.projects?.length ? (
              <div className="mb-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor rounded-lg p-3">
                    <div className="text-lg font-semibold text-bolt-elements-textPrimary">
                      {connection.stats.totalProjects}
                    </div>
                    <div className="text-xs text-bolt-elements-textSecondary">Total Projects</div>
                  </div>
                  <div className="bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor rounded-lg p-3">
                    <div className="text-lg font-semibold text-bolt-elements-textPrimary">
                      {connection.stats.projects.filter((p) => p.latestDeployments?.[0]?.state === 'READY').length}
                    </div>
                    <div className="text-xs text-bolt-elements-textSecondary">Live (READY)</div>
                  </div>
                  <div className="bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor rounded-lg p-3">
                    <div className="text-lg font-semibold text-bolt-elements-textPrimary">
                      {new Set(connection.stats.projects.map((p) => p.framework).filter(Boolean)).size}
                    </div>
                    <div className="text-xs text-bolt-elements-textSecondary">Frameworks</div>
                  </div>
                  <div className="bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor rounded-lg p-3">
                    <div className="text-lg font-semibold text-bolt-elements-textPrimary">
                      {connection.stats.projects.reduce(
                        (sum, p) => sum + (p.targets?.production?.alias ? p.targets.production.alias.length : 0),
                        0,
                      )}
                    </div>
                    <div className="text-xs text-bolt-elements-textSecondary">Domains</div>
                  </div>
                </div>
                {/* Alert bar for errors or building projects */}
                {(() => {
                  const errorCount = connection.stats.projects.filter(
                    (p) =>
                      p.latestDeployments?.[0]?.state === 'ERROR' || p.latestDeployments?.[0]?.state === 'CANCELED',
                  ).length;
                  const buildingCount = connection.stats.projects.filter(
                    (p) => p.latestDeployments?.[0]?.state === 'BUILDING',
                  ).length;

                  if (errorCount === 0 && buildingCount === 0) {
                    return null;
                  }

                  return (
                    <div className="mt-3 flex items-center gap-3 px-3 py-2 rounded-lg bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor text-xs text-bolt-elements-textSecondary">
                      {errorCount > 0 && (
                        <span className="flex items-center gap-1 text-red-500">
                          <div className="i-ph:warning w-3.5 h-3.5" />
                          {errorCount} {errorCount === 1 ? 'project' : 'projects'} with errors
                        </span>
                      )}
                      {buildingCount > 0 && (
                        <span className="flex items-center gap-1 text-yellow-500">
                          <div className="i-ph:gear w-3.5 h-3.5 animate-spin" />
                          {buildingCount} building
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
            ) : null}

            {connection.stats?.projects?.length ? (
              <div className="grid gap-3">
                {connection.stats.projects.map((project) => (
                  <div
                    key={project.id}
                    className="p-4 rounded-lg border border-bolt-elements-borderColor hover:border-bolt-elements-borderColorActive/70 transition-colors bg-bolt-elements-background-depth-1"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <h5 className="text-sm font-medium text-bolt-elements-textPrimary flex items-center gap-2">
                          <div className="i-ph:globe w-4 h-4 text-bolt-elements-borderColorActive" />
                          {project.name}
                        </h5>
                        <div className="flex items-center gap-2 mt-2 text-xs text-bolt-elements-textSecondary">
                          {project.targets?.production?.alias && project.targets.production.alias.length > 0 ? (
                            <>
                              <a
                                href={`https://${project.targets.production.alias.find((a: string) => a.endsWith('.vercel.app') && !a.includes('-projects.vercel.app')) || project.targets.production.alias[0]}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-bolt-elements-borderColorActive underline"
                              >
                                {project.targets.production.alias.find(
                                  (a: string) => a.endsWith('.vercel.app') && !a.includes('-projects.vercel.app'),
                                ) || project.targets.production.alias[0]}
                              </a>
                              <span>•</span>
                              <span className="flex items-center gap-1">
                                <div className="i-ph:clock w-3 h-3" />
                                {new Date(project.createdAt).toLocaleDateString()}
                              </span>
                            </>
                          ) : project.latestDeployments && project.latestDeployments.length > 0 ? (
                            <>
                              <a
                                href={`https://${project.latestDeployments[0].url}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-bolt-elements-borderColorActive underline"
                              >
                                {project.latestDeployments[0].url}
                              </a>
                              <span>•</span>
                              <span className="flex items-center gap-1">
                                <div className="i-ph:clock w-3 h-3" />
                                {new Date(project.latestDeployments[0].created).toLocaleDateString()}
                              </span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {project.latestDeployments && project.latestDeployments.length > 0 && (
                          <div
                            className={cn(
                              'flex items-center gap-1 px-2 py-1 rounded-full text-xs',
                              project.latestDeployments[0].state === 'READY'
                                ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400'
                                : project.latestDeployments[0].state === 'ERROR'
                                  ? 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400'
                                  : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400',
                            )}
                          >
                            <div
                              className={cn(
                                'w-2 h-2 rounded-full',
                                project.latestDeployments[0].state === 'READY'
                                  ? 'bg-green-500'
                                  : project.latestDeployments[0].state === 'ERROR'
                                    ? 'bg-red-500'
                                    : 'bg-yellow-500',
                              )}
                            />
                            {project.latestDeployments[0].state}
                          </div>
                        )}
                        {project.framework && (
                          <div className="text-xs text-bolt-elements-textSecondary px-2 py-1 rounded-md bg-bolt-elements-background-depth-2">
                            <span className="flex items-center gap-1">
                              <div className="i-ph:code w-3 h-3" />
                              {project.framework}
                            </span>
                          </div>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            window.open(`https://vercel.com/dashboard/${project.id}`, '_blank', 'noopener,noreferrer')
                          }
                          className="flex items-center gap-1 text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary"
                        >
                          <div className="i-ph:arrow-square-out w-3 h-3" />
                          View
                        </Button>
                      </div>
                    </div>

                    <div className="flex items-center flex-wrap gap-1 mt-3 pt-3 border-t border-bolt-elements-borderColor">
                      {projectActions.map((action) => (
                        <Button
                          key={action.name}
                          variant={action.variant || 'outline'}
                          size="sm"
                          onClick={() => handleProjectAction(project.id, action)}
                          disabled={isProjectActionLoading}
                          className="flex items-center gap-1 text-xs px-2 py-1 text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary"
                        >
                          <div className={`${action.icon} w-2.5 h-2.5`} />
                          {action.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-bolt-elements-textSecondary flex items-center gap-2 p-4">
                <div className="i-ph:info w-4 h-4" />
                No projects found in your Vercel account
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }, [
    connection.stats,
    fetchingStats,
    isProjectsExpanded,
    isProjectActionLoading,
    handleProjectAction,
    projectActions,
  ]);

  logger.debug('connection', connection);

  return (
    <div className="space-y-6">
      <ServiceHeader
        icon={VercelLogo}
        title="Vercel Integration"
        description="Connect and manage your Vercel projects with advanced deployment controls and analytics"
        onTestConnection={connection.user ? () => testConnection() : undefined}
        isTestingConnection={isTestingConnection}
      />

      <ConnectionTestIndicator testResult={connectionTest} />

      {/* Main Connection Component */}
      <motion.div
        className="bg-bolt-elements-background dark:bg-bolt-elements-background border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor rounded-lg"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <div className="p-6 space-y-6">
          {!connection.user ? (
            <div className="space-y-4">
              <div className="text-xs text-bolt-elements-textSecondary bg-bolt-elements-background-depth-1 dark:bg-bolt-elements-background-depth-1 p-3 rounded-lg mb-4">
                <p className="flex items-center gap-1 mb-1">
                  <span className="i-ph:lightbulb w-3.5 h-3.5 text-bolt-elements-icon-success dark:text-bolt-elements-icon-success" />
                  <span className="font-medium">Tip:</span> You can also set the{' '}
                  <code className="px-1 py-0.5 bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-2 rounded">
                    VITE_VERCEL_ACCESS_TOKEN
                  </code>{' '}
                  environment variable to connect automatically.
                </p>
              </div>

              <div>
                <label className="block text-sm text-bolt-elements-textSecondary mb-2">Personal Access Token</label>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={connection.token}
                  onChange={(e) => updateVercelConnection({ ...connection, token: e.target.value })}
                  disabled={connecting}
                  placeholder="Enter your Vercel personal access token"
                  className={cn(
                    'w-full px-3 py-2 rounded-lg text-sm',
                    'bg-bolt-elements-background-depth-1',
                    'border border-bolt-elements-borderColor',
                    'text-bolt-elements-textPrimary placeholder-bolt-elements-textTertiary',
                    'focus:outline-none focus:ring-1 focus:ring-bolt-elements-borderColorActive',
                    'disabled:opacity-50',
                  )}
                />
                <div className="mt-2 text-sm text-bolt-elements-textSecondary">
                  <a
                    href="https://vercel.com/account/tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-bolt-elements-borderColorActive hover:underline inline-flex items-center gap-1"
                  >
                    Get your token
                    <div className="i-ph:arrow-square-out w-4 h-4" />
                  </a>
                </div>
              </div>

              <button
                onClick={handleConnect}
                disabled={connecting || !connection.token}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm flex items-center gap-2',
                  'bg-bolt-elements-bg-depth-3 text-bolt-elements-textPrimary',
                  'hover:bg-[#5E41D0] hover:text-white',
                  'disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200',
                  'transform active:scale-95',
                )}
              >
                {connecting ? (
                  <>
                    <div className="i-ph:spinner-gap animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <div className="i-ph:plug-charging w-4 h-4" />
                    Connect
                  </>
                )}
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleDisconnect}
                    className={cn(
                      'px-4 py-2 rounded-lg text-sm flex items-center gap-2',
                      'bg-red-500 text-white',
                      'hover:bg-red-600',
                    )}
                  >
                    <div className="i-ph:plug w-4 h-4" />
                    Disconnect
                  </button>
                  <span className="text-sm text-bolt-elements-textSecondary flex items-center gap-1">
                    <div className="i-ph:check-circle w-4 h-4 text-green-500" />
                    Connected to Vercel
                  </span>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-4 p-4 bg-bolt-elements-background-depth-1 dark:bg-bolt-elements-background-depth-1 rounded-lg">
                  <img
                    loading="lazy"
                    src={`https://vercel.com/api/www/avatar?u=${connection.user?.username}`}
                    referrerPolicy="no-referrer"
                    crossOrigin="anonymous"
                    alt="User Avatar"
                    className="w-12 h-12 rounded-full border-2 border-bolt-elements-borderColorActive"
                  />
                  <div className="flex-1">
                    <h4 className="text-sm font-medium text-bolt-elements-textPrimary">
                      {connection.user?.username || 'Vercel User'}
                    </h4>
                    <p className="text-sm text-bolt-elements-textSecondary">
                      {connection.user?.email || 'No email available'}
                    </p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-bolt-elements-textSecondary">
                      <span className="flex items-center gap-1">
                        <div className="i-ph:buildings w-3 h-3" />
                        {connection.stats?.totalProjects || 0} Projects
                      </span>
                      <span className="flex items-center gap-1">
                        <div className="i-ph:check-circle w-3 h-3" />
                        {connection.stats?.projects.filter((p) => p.latestDeployments?.[0]?.state === 'READY').length ||
                          0}{' '}
                        Live
                      </span>
                      <span className="flex items-center gap-1">
                        <div className="i-ph:users w-3 h-3" />
                        {/* Team size would be fetched from API */}
                        --
                      </span>
                    </div>
                  </div>
                </div>

                {/* Usage Metrics */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-3 bg-bolt-elements-background-depth-1 rounded-lg border border-bolt-elements-borderColor">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="i-ph:buildings w-4 h-4 text-bolt-elements-item-contentAccent" />
                      <span className="text-xs font-medium text-bolt-elements-textPrimary">Projects</span>
                    </div>
                    <div className="text-sm text-bolt-elements-textSecondary">
                      <div>
                        Active:{' '}
                        {connection.stats?.projects.filter((p) => p.latestDeployments?.[0]?.state === 'READY').length ||
                          0}
                      </div>
                      <div>Total: {connection.stats?.totalProjects || 0}</div>
                    </div>
                  </div>
                  <div className="p-3 bg-bolt-elements-background-depth-1 rounded-lg border border-bolt-elements-borderColor">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="i-ph:globe w-4 h-4 text-bolt-elements-item-contentAccent" />
                      <span className="text-xs font-medium text-bolt-elements-textPrimary">Domains</span>
                    </div>
                    <div className="text-sm text-bolt-elements-textSecondary">
                      {/* Domain usage would be fetched from API */}
                      <div>Custom: --</div>
                      <div>Vercel: --</div>
                    </div>
                  </div>
                  <div className="p-3 bg-bolt-elements-background-depth-1 rounded-lg border border-bolt-elements-borderColor">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="i-ph:activity w-4 h-4 text-bolt-elements-item-contentAccent" />
                      <span className="text-xs font-medium text-bolt-elements-textPrimary">Usage</span>
                    </div>
                    <div className="text-sm text-bolt-elements-textSecondary">
                      {/* Usage metrics would be fetched from API */}
                      <div>Bandwidth: --</div>
                      <div>Requests: --</div>
                    </div>
                  </div>
                </div>
              </div>

              {renderProjects()}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
