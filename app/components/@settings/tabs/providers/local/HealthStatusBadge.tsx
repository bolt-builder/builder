import { cn } from '~/utils/cn';

interface HealthStatusBadgeProps {
  status: 'healthy' | 'unhealthy' | 'checking' | 'unknown';
  responseTime?: number;
  className?: string;
}

function HealthStatusBadge({ status, responseTime, className }: HealthStatusBadgeProps) {
  const getStatusConfig = () => {
    switch (status) {
      case 'healthy':
        return {
          color: 'text-green-500',
          bgColor: 'bg-green-500/10 border-green-500/20',
          iconClass: 'i-ph:check-circle',
          label: 'Healthy',
        };
      case 'unhealthy':
        return {
          color: 'text-red-500',
          bgColor: 'bg-red-500/10 border-red-500/20',
          iconClass: 'i-ph:x-circle',
          label: 'Unhealthy',
        };
      case 'checking':
        return {
          color: 'text-blue-500',
          bgColor: 'bg-blue-500/10 border-blue-500/20',
          iconClass: 'i-ph:spinner animate-spin',
          label: 'Checking',
        };
      default:
        return {
          color: 'text-bolt-elements-textTertiary',
          bgColor: 'bg-bolt-elements-background-depth-3 border-bolt-elements-borderColor',
          iconClass: 'i-ph:warning-circle',
          label: 'Unknown',
        };
    }
  };

  const config = getStatusConfig();

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
        config.bgColor,
        config.color,
        className,
      )}
    >
      <div className={cn('w-3 h-3', config.iconClass)} />
      <span>{config.label}</span>
      {responseTime !== undefined && status === 'healthy' && <span className="opacity-75">({responseTime}ms)</span>}
    </div>
  );
}

export default HealthStatusBadge;
