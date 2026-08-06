import { memo, type ComponentPropsWithoutRef } from 'react';
import { cn } from '~/utils/cn';

type IconSize = 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

interface BaseIconButtonProps {
  size?: IconSize;
  className?: string;
  iconClassName?: string;
  disabledClassName?: string;
  title?: string;
  disabled?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
  ref?: React.Ref<HTMLButtonElement>;
}

type IconButtonWithoutChildrenProps = {
  icon: string;
  children?: undefined;
} & BaseIconButtonProps &
  Omit<ComponentPropsWithoutRef<'button'>, keyof BaseIconButtonProps | 'icon' | 'children'>;

type IconButtonWithChildrenProps = {
  icon?: undefined;
  children: string | JSX.Element | JSX.Element[];
} & BaseIconButtonProps &
  Omit<ComponentPropsWithoutRef<'button'>, keyof BaseIconButtonProps | 'icon' | 'children'>;

type IconButtonProps = IconButtonWithoutChildrenProps | IconButtonWithChildrenProps;

export const IconButton = memo(
  ({
    icon,
    size = 'xl',
    className,
    iconClassName,
    disabledClassName,
    disabled = false,
    title,
    onClick,
    children,
    ref,
    ...rest
  }: IconButtonProps) => {
    return (
      <button
        ref={ref}
        {...rest}
        className={cn(
          'flex items-center text-bolt-elements-item-contentDefault bg-transparent enabled:hover:text-bolt-elements-item-contentActive rounded-md p-1 enabled:hover:bg-bolt-elements-item-backgroundActive disabled:cursor-not-allowed',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-focus',
          {
            [cn('opacity-30', disabledClassName)]: disabled,
          },
          className,
        )}
        title={title}
        disabled={disabled}
        onClick={(event) => {
          if (disabled) {
            return;
          }

          onClick?.(event);
        }}
      >
        {children ? children : <div className={cn(icon, getIconSize(size), iconClassName)}></div>}
      </button>
    );
  },
);

function getIconSize(size: IconSize) {
  if (size === 'sm') {
    return 'text-sm';
  } else if (size === 'md') {
    return 'text-md';
  } else if (size === 'lg') {
    return 'text-lg';
  } else if (size === 'xl') {
    return 'text-xl';
  } else {
    return 'text-2xl';
  }
}
