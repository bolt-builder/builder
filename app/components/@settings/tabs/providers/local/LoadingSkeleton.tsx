import { cn } from '~/utils/cn';

interface LoadingSkeletonProps {
  className?: string;
  lines?: number;
  height?: string;
}

function LoadingSkeleton({ className, lines = 1, height = 'h-4' }: LoadingSkeletonProps) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className={cn('bg-bolt-elements-background-depth-3 rounded', height, 'animate-pulse')}
          style={{ animationDelay: `${i * 0.1}s` }}
        />
      ))}
    </div>
  );
}

interface ModelCardSkeletonProps {
  className?: string;
}

export function ModelCardSkeleton({ className }: ModelCardSkeletonProps) {
  return (
    <div
      className={cn(
        'border rounded-lg p-4',
        'bg-bolt-elements-background-depth-2',
        'border-bolt-elements-borderColor',
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 flex-1">
          <div className="w-3 h-3 rounded-full bg-bolt-elements-textTertiary animate-pulse" />
          <div className="space-y-2 flex-1">
            <LoadingSkeleton height="h-5" lines={1} className="w-3/4" />
            <LoadingSkeleton height="h-3" lines={1} className="w-1/2" />
          </div>
        </div>
        <div className="w-4 h-4 bg-bolt-elements-textTertiary rounded animate-pulse" />
      </div>
    </div>
  );
}
