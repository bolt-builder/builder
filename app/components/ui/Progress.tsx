import * as React from 'react';
import { cn } from '~/utils/cn';

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  ref?: React.Ref<HTMLDivElement>;
}

function Progress({ className, value, ref, ...props }: ProgressProps) {
  return (
    <div
      ref={ref}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-bolt-elements-background', className)}
      {...props}
    >
      <div
        className="h-full w-full flex-1 bg-bolt-elements-textPrimary transition-all"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </div>
  );
}

export { Progress };
