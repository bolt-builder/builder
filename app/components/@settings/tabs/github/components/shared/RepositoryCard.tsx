import { cn } from '~/utils/cn';
import { formatSize } from '~/utils/formatSize';
import type { GitHubRepoInfo } from '~/types/GitHub';

interface RepositoryCardProps {
  repository: GitHubRepoInfo;
  variant?: 'default' | 'compact' | 'detailed';
  onSelect?: () => void;
  showHealthScore?: boolean;
  showExtendedMetrics?: boolean;
  className?: string;
}

export function RepositoryCard({
  repository,
  variant = 'default',
  onSelect,
  showHealthScore = false,
  showExtendedMetrics = false,
  className = '',
}: RepositoryCardProps) {
  const daysSinceUpdate = Math.floor((Date.now() - new Date(repository.updated_at).getTime()) / (1000 * 60 * 60 * 24));

  const formatTimeAgo = () => {
    if (daysSinceUpdate === 0) {
      return 'Today';
    }

    if (daysSinceUpdate === 1) {
      return '1 day ago';
    }

    if (daysSinceUpdate < 7) {
      return `${daysSinceUpdate} days ago`;
    }

    if (daysSinceUpdate < 30) {
      return `${Math.floor(daysSinceUpdate / 7)} weeks ago`;
    }

    return new Date(repository.updated_at).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const calculateHealthScore = () => {
    const hasStars = repository.stargazers_count > 0;
    const hasRecentActivity = daysSinceUpdate < 30;
    const hasContributors = (repository.contributors_count || 0) > 1;
    const hasDescription = !!repository.description;
    const hasTopics = (repository.topics || []).length > 0;
    const hasLicense = !!repository.license;

    const healthScore = [hasStars, hasRecentActivity, hasContributors, hasDescription, hasTopics, hasLicense].filter(
      Boolean,
    ).length;

    const maxScore = 6;
    const percentage = Math.round((healthScore / maxScore) * 100);

    const getScoreColor = (score: number) => {
      if (score >= 5) {
        return 'text-green-500';
      }

      if (score >= 3) {
        return 'text-yellow-500';
      }

      return 'text-red-500';
    };

    return {
      percentage,
      color: getScoreColor(healthScore),
      score: healthScore,
      maxScore,
    };
  };

  const getHealthIndicatorColor = () => {
    const isActive = daysSinceUpdate < 7;
    const isHealthy = daysSinceUpdate < 30 && !repository.archived && repository.stargazers_count > 0;

    if (repository.archived) {
      return 'bg-gray-500';
    }

    if (isActive) {
      return 'bg-green-500';
    }

    if (isHealthy) {
      return 'bg-blue-500';
    }

    return 'bg-yellow-500';
  };

  const getHealthTitle = () => {
    if (repository.archived) {
      return 'Archived';
    }

    if (daysSinceUpdate < 7) {
      return 'Very Active';
    }

    if (daysSinceUpdate < 30 && repository.stargazers_count > 0) {
      return 'Healthy';
    }

    return 'Needs Attention';
  };

  const health = showHealthScore ? calculateHealthScore() : null;

  if (variant === 'compact') {
    return (
      <button
        onClick={onSelect}
        className={cn(
          'w-full text-left p-3 rounded-lg border border-bolt-elements-borderColor hover:border-bolt-elements-borderColorActive hover:bg-bolt-elements-background-depth-1 transition-all duration-200',
          className,
        )}
      >
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium text-bolt-elements-textPrimary">{repository.name}</h4>
            {repository.private && <div className="i-ph:lock size-3 text-bolt-elements-textTertiary" />}
            {repository.fork && <div className="i-ph:git-fork size-3 text-bolt-elements-textTertiary" />}
            {repository.archived && <div className="i-ph:archive size-3 text-bolt-elements-textTertiary" />}
          </div>

          <div className="flex items-center gap-3 text-xs text-bolt-elements-textSecondary">
            <span className="flex items-center gap-1">
              <div className="i-ph:star size-3" />
              {repository.stargazers_count}
            </span>
            <span className="flex items-center gap-1">
              <div className="i-ph:git-fork size-3" />
              {repository.forks_count}
            </span>
          </div>
        </div>

        {repository.description && (
          <p className="text-xs text-bolt-elements-textSecondary mb-2 line-clamp-2">{repository.description}</p>
        )}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs text-bolt-elements-textTertiary">
            {repository.language && (
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-current opacity-60" />
                {repository.language}
              </span>
            )}
            {repository.size && <span>{formatSize(repository.size * 1024)}</span>}
          </div>

          <span className="flex items-center gap-1 text-xs text-bolt-elements-textTertiary">
            <div className="i-ph:clock size-3" />
            {formatTimeAgo()}
          </span>
        </div>
      </button>
    );
  }

  const Component = onSelect ? 'button' : 'div';
  const interactiveProps = onSelect
    ? {
        onClick: onSelect,
        className: cn(
          'group cursor-pointer hover:border-bolt-elements-borderColorActive dark:hover:border-bolt-elements-borderColorActive transition-all duration-200',
          className,
        ),
      }
    : { className };

  return (
    <Component
      {...interactiveProps}
      className={cn(
        'block p-4 rounded-lg bg-bolt-elements-background-depth-1 dark:bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor relative',
        interactiveProps.className,
      )}
    >
      {/* Repository Health Indicator */}
      {variant === 'detailed' && (
        <div
          className={`absolute top-2 right-2 w-2 h-2 rounded-full ${getHealthIndicatorColor()}`}
          title={`Repository Health: ${getHealthTitle()}`}
        />
      )}

      <div className="space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <div className="i-ph:git-branch size-4 text-bolt-elements-icon-tertiary" />
            <h5
              className={cn(
                'text-sm font-medium text-bolt-elements-textPrimary',
                onSelect && 'group-hover:text-bolt-elements-item-contentAccent transition-colors',
              )}
            >
              {repository.name}
            </h5>
            {repository.fork && (
              <span title="Forked repository">
                <div className="i-ph:git-fork size-3 text-bolt-elements-textTertiary" />
              </span>
            )}
            {repository.archived && (
              <span title="Archived repository">
                <div className="i-ph:archive size-3 text-bolt-elements-textTertiary" />
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-bolt-elements-textSecondary">
            <span className="flex items-center gap-1" title="Stars">
              <div className="i-ph:star size-3.5 text-bolt-elements-icon-warning" />
              {repository.stargazers_count.toLocaleString()}
            </span>
            <span className="flex items-center gap-1" title="Forks">
              <div className="i-ph:git-fork size-3.5 text-bolt-elements-icon-info" />
              {repository.forks_count.toLocaleString()}
            </span>
            {showExtendedMetrics && repository.issues_count !== undefined && (
              <span className="flex items-center gap-1" title="Open Issues">
                <div className="i-ph:circle size-3.5 text-bolt-elements-icon-error" />
                {repository.issues_count}
              </span>
            )}
            {showExtendedMetrics && repository.pull_requests_count !== undefined && (
              <span className="flex items-center gap-1" title="Pull Requests">
                <div className="i-ph:git-pull-request size-3.5 text-bolt-elements-icon-success" />
                {repository.pull_requests_count}
              </span>
            )}
          </div>
        </div>

        <div className="space-y-2">
          {repository.description && (
            <p className="text-xs text-bolt-elements-textSecondary line-clamp-2">{repository.description}</p>
          )}

          {/* Repository metrics bar */}
          <div className="flex items-center gap-2 text-xs">
            {repository.license && (
              <span className="px-2 py-0.5 rounded-full bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary">
                {repository.license.spdx_id || repository.license.name}
              </span>
            )}
            {repository.topics &&
              repository.topics.slice(0, 2).map((topic) => (
                <span
                  key={topic}
                  className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400"
                >
                  {topic}
                </span>
              ))}
            {repository.archived && (
              <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400">
                Archived
              </span>
            )}
            {repository.fork && (
              <span className="px-2 py-0.5 rounded-full bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent">
                Fork
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs text-bolt-elements-textSecondary">
            <span className="flex items-center gap-1" title="Default Branch">
              <div className="i-ph:git-branch size-3.5" />
              {repository.default_branch}
            </span>
            {showExtendedMetrics && repository.branches_count && (
              <span className="flex items-center gap-1" title="Total Branches">
                <div className="i-ph:git-fork size-3.5" />
                {repository.branches_count}
              </span>
            )}
            {showExtendedMetrics && repository.contributors_count && (
              <span className="flex items-center gap-1" title="Contributors">
                <div className="i-ph:users size-3.5" />
                {repository.contributors_count}
              </span>
            )}
            {repository.size && (
              <span className="flex items-center gap-1" title="Size">
                <div className="i-ph:database size-3.5" />
                {(repository.size / 1024).toFixed(1)}MB
              </span>
            )}
            <span className="flex items-center gap-1" title="Last Updated">
              <div className="i-ph:clock size-3.5" />
              {formatTimeAgo()}
            </span>
            {repository.topics && repository.topics.length > 0 && (
              <span className="flex items-center gap-1" title={`Topics: ${repository.topics.join(', ')}`}>
                <div className="i-ph:tag size-3.5" />
                {repository.topics.length}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Repository Health Score */}
            {health && (
              <div
                className="flex items-center gap-1"
                title={`Health Score: ${health.percentage}% (${health.score}/${health.maxScore})`}
              >
                <div className={`i-ph:heart size-3.5 ${health.color}`} />
                <span className={`text-xs font-medium ${health.color}`}>{health.percentage}%</span>
              </div>
            )}

            {onSelect && (
              <span
                className={cn(
                  'flex items-center gap-1 ml-2 transition-colors',
                  'group-hover:text-bolt-elements-item-contentAccent',
                )}
              >
                <div className="i-ph:arrow-square-out size-3.5" />
                View
              </span>
            )}
          </div>
        </div>
      </div>
    </Component>
  );
}
