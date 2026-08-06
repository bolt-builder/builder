import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactElement, Ref } from 'react';

// Original WithTooltip component
interface WithTooltipProps {
  tooltip: React.ReactNode;
  children: ReactElement;
  sideOffset?: number;
  className?: string;
  arrowClassName?: string;
  tooltipStyle?: React.CSSProperties;
  position?: 'top' | 'bottom' | 'left' | 'right';
  maxWidth?: number;
  delay?: number;
  ref?: Ref<HTMLElement>;
}

function WithTooltip({
  tooltip,
  children,
  sideOffset = 5,
  className = '',
  arrowClassName = '',
  tooltipStyle = {},
  position = 'top',
  maxWidth = 250,
  delay = 0,
}: WithTooltipProps) {
  return (
    <TooltipPrimitive.Provider>
      <TooltipPrimitive.Root delayDuration={delay}>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={position}
            className={`
                z-[2000]
                px-2.5
                py-1.5
                max-h-[300px]
                select-none
                rounded-md
                bg-bolt-elements-background-depth-3
                text-bolt-elements-textPrimary
                text-sm
                leading-tight
                shadow-lg
                animate-in
                fade-in-0
                zoom-in-95
                data-[state=closed]:animate-out
                data-[state=closed]:fade-out-0
                data-[state=closed]:zoom-out-95
                ${className}
              `}
            sideOffset={sideOffset}
            style={{
              maxWidth,
              ...tooltipStyle,
            }}
          >
            <div className="break-words">{tooltip}</div>
            <TooltipPrimitive.Arrow
              className={`
                  fill-bolt-elements-background-depth-3
                  ${arrowClassName}
                `}
              width={12}
              height={6}
            />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export default WithTooltip;
