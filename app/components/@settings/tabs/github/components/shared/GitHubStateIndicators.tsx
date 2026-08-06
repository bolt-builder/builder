import { cn } from '~/utils/cn';

interface LoadingStateProps {
  message?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function LoadingState({ message = 'Loading...', size = 'md', className = '' }: LoadingStateProps) {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-6 h-6',
    lg: 'w-8 h-8',
  };

  const textSizeClasses = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg',
  };

  return (
    <div className={cn('flex flex-col items-center justify-center py-8 text-bolt-elements-textSecondary', className)}>
      <div className={cn('i-ph:spinner animate-spin mb-2', sizeClasses[size])} />
      <p className={cn('text-bolt-elements-textSecondary', textSizeClasses[size])}>{message}</p>
    </div>
  );
}

interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function ErrorState({
  title = 'Error',
  message,
  onRetry,
  retryLabel = 'Try Again',
  size = 'md',
  className = '',
}: ErrorStateProps) {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-6 h-6',
    lg: 'w-8 h-8',
  };

  const textSizeClasses = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg',
  };

  return (
    <div className={cn('flex flex-col items-center justify-center py-8 text-center', className)}>
      <div className={cn('i-ph:warning-circle text-red-500 mb-2', sizeClasses[size])} />
      <h3 className={cn('font-medium text-bolt-elements-textPrimary mb-1', textSizeClasses[size])}>{title}</h3>
      <p className={cn('text-bolt-elements-textSecondary mb-4', textSizeClasses[size])}>{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-4 py-2 bg-bolt-elements-item-contentAccent text-white rounded-lg hover:bg-bolt-elements-item-contentAccent/90 transition-colors"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

interface ConnectionTestIndicatorProps {
  status: 'success' | 'error' | 'testing' | null;
  message?: string;
  timestamp?: number;
  className?: string;
}

export function ConnectionTestIndicator({ status, message, timestamp, className = '' }: ConnectionTestIndicatorProps) {
  if (!status) {
    return null;
  }

  const getStatusColor = () => {
    switch (status) {
      case 'success':
        return 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-700';
      case 'error':
        return 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-700';
      case 'testing':
        return 'bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-700';
      default:
        return 'bg-gray-50 border-gray-200 dark:bg-gray-900/20 dark:border-gray-700';
    }
  };

  const getStatusIcon = () => {
    switch (status) {
      case 'success':
        return <div className="i-ph:check-circle size-5 text-green-600 dark:text-green-400" />;
      case 'error':
        return <div className="i-ph:warning-circle size-5 text-red-600 dark:text-red-400" />;
      case 'testing':
        return <div className="i-ph:spinner size-5 animate-spin text-blue-600 dark:text-blue-400" />;
      default:
        return <div className="i-ph:info size-5 text-gray-600 dark:text-gray-400" />;
    }
  };

  const getStatusTextColor = () => {
    switch (status) {
      case 'success':
        return 'text-green-800 dark:text-green-200';
      case 'error':
        return 'text-red-800 dark:text-red-200';
      case 'testing':
        return 'text-blue-800 dark:text-blue-200';
      default:
        return 'text-gray-800 dark:text-gray-200';
    }
  };

  return (
    <div className={cn(`p-4 rounded-lg border ${getStatusColor()}`, className)}>
      <div className="flex items-center gap-2">
        {getStatusIcon()}
        <span className={cn('text-sm font-medium', getStatusTextColor())}>{message || status}</span>
      </div>
      {timestamp && <p className="text-xs text-gray-500 mt-1">{new Date(timestamp).toLocaleString()}</p>}
    </div>
  );
}
