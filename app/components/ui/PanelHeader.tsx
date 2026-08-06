import { memo } from 'react';
import { cn } from '~/utils/cn';

interface PanelHeaderProps {
  className?: string;
  children: React.ReactNode;
}

export const PanelHeader = memo(({ className, children }: PanelHeaderProps) => {
  return (
    <div
      className={cn(
        'flex items-center gap-2 text-bolt-elements-textSecondary border-b border-bolt-elements-borderColor px-4 py-1 min-h-[34px] text-sm',
        className,
      )}
      style={{ background: 'var(--bolt-elements-bg-depth-1)' }}
    >
      {children}
    </div>
  );
});
