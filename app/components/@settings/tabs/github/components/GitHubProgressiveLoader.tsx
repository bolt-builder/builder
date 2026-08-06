import React, { useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '~/components/ui/Button';
import { cn } from '~/utils/cn';

interface ProgressiveLoaderProps {
  isLoading: boolean;
  isRefreshing?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onRefresh?: () => void;
  children: React.ReactNode;
  className?: string;
  loadingMessage?: string;
  refreshingMessage?: string;
  showProgress?: boolean;
  progressSteps?: Array<{
    key: string;
    label: string;
    completed: boolean;
    loading?: boolean;
    error?: boolean;
  }>;
}

export function GitHubProgressiveLoader({
  isLoading,
  isRefreshing = false,
  error,
  onRetry,
  onRefresh,
  children,
  className = '',
  loadingMessage = 'Loading...',
  refreshingMessage = 'Refreshing...',
  showProgress = false,
  progressSteps = [],
}: ProgressiveLoaderProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Calculate progress percentage
  const progress = useMemo(() => {
    if (!showProgress || progressSteps.length === 0) {
      return 0;
    }

    const completed = progressSteps.filter((step) => step.completed).length;

    return Math.round((completed / progressSteps.length) * 100);
  }, [showProgress, progressSteps]);

  const handleToggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  // Loading state with progressive steps
  if (isLoading) {
    return (
      <div className={cn('flex flex-col items-center justify-center py-8', className)}>
        <div className="relative mb-4">
          <div className="i-ph:spinner w-8 h-8 animate-spin text-bolt-elements-item-contentAccent" />
          {showProgress && progress > 0 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-xs font-medium text-bolt-elements-item-contentAccent">{progress}%</span>
            </div>
          )}
        </div>

        <div className="text-center space-y-2">
          <p className="text-sm font-medium text-bolt-elements-textPrimary">{loadingMessage}</p>

          {showProgress && progressSteps.length > 0 && (
            <div className="w-full max-w-sm">
              {/* Progress bar */}
              <div className="w-full bg-bolt-elements-background-depth-2 rounded-full h-2 mb-3">
                <motion.div
                  className="bg-bolt-elements-item-contentAccent h-2 rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.5, ease: 'easeOut' }}
                />
              </div>

              {/* Steps toggle */}
              <button
                onClick={handleToggleExpanded}
                className="flex items-center justify-center gap-2 text-xs text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors"
              >
                <span>Show details</span>
                <div
                  className={cn(
                    'i-ph:caret-down w-3 h-3 transform transition-transform duration-200',
                    isExpanded ? 'rotate-180' : '',
                  )}
                />
              </button>

              {/* Progress steps */}
              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="mt-3 space-y-2 overflow-hidden"
                  >
                    {progressSteps.map((step) => (
                      <div key={step.key} className="flex items-center gap-2 text-xs">
                        {step.error ? (
                          <div className="i-ph:warning-circle w-3 h-3 text-red-500 flex-shrink-0" />
                        ) : step.completed ? (
                          <div className="i-ph:check-circle w-3 h-3 text-green-500 flex-shrink-0" />
                        ) : step.loading ? (
                          <div className="i-ph:spinner w-3 h-3 animate-spin text-bolt-elements-item-contentAccent flex-shrink-0" />
                        ) : (
                          <div className="w-3 h-3 rounded-full border border-bolt-elements-borderColor flex-shrink-0" />
                        )}
                        <span
                          className={cn(
                            step.error
                              ? 'text-red-500'
                              : step.completed
                                ? 'text-green-600 dark:text-green-400'
                                : step.loading
                                  ? 'text-bolt-elements-textPrimary'
                                  : 'text-bolt-elements-textSecondary',
                          )}
                        >
                          {step.label}
                        </span>
                      </div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className={cn('flex flex-col items-center justify-center py-8 text-center space-y-4', className)}>
        <div className="w-10 h-10 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center">
          <div className="i-ph:warning-circle w-5 h-5 text-red-500" />
        </div>

        <div>
          <h3 className="text-sm font-medium text-bolt-elements-textPrimary mb-1">Failed to Load</h3>
          <p className="text-xs text-bolt-elements-textSecondary mb-4 max-w-sm">{error}</p>
        </div>

        <div className="flex gap-2">
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry} className="text-xs">
              <div className="i-ph:arrows-clockwise w-3 h-3 mr-1" />
              Try Again
            </Button>
          )}
          {onRefresh && (
            <Button variant="outline" size="sm" onClick={onRefresh} className="text-xs">
              <div className="i-ph:arrows-clockwise w-3 h-3 mr-1" />
              Refresh
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Success state - render children with optional refresh indicator
  return (
    <div className={cn('relative', className)}>
      {isRefreshing && (
        <div className="absolute top-0 right-0 z-10">
          <div className="flex items-center gap-2 px-2 py-1 bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor rounded-lg shadow-sm">
            <div className="i-ph:spinner w-3 h-3 animate-spin text-bolt-elements-item-contentAccent" />
            <span className="text-xs text-bolt-elements-textSecondary">{refreshingMessage}</span>
          </div>
        </div>
      )}

      {children}
    </div>
  );
}
