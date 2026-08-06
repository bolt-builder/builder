import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '~/utils/cn';

interface TabsListProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
  ref?: React.Ref<React.ElementRef<typeof TabsPrimitive.List>>;
}

function TabsList({ className, ref, ...props }: TabsListProps) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        'inline-flex h-10 items-center justify-center rounded-md bg-bolt-elements-background-depth-1 dark:bg-bolt-elements-background-depth-3-dark p-1 text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark',
        className,
      )}
      {...props}
    />
  );
}

interface TabsTriggerProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> {
  ref?: React.Ref<React.ElementRef<typeof TabsPrimitive.Trigger>>;
}

function TabsTrigger({ className, ref, ...props }: TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-bolt-elements-background dark:ring-offset-bolt-elements-background-dark transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-bolt-elements-background-depth-0 dark:data-[state=active]:bg-bolt-elements-background-depth-2-dark data-[state=active]:text-bolt-elements-textPrimary dark:data-[state=active]:text-bolt-elements-textPrimary-dark data-[state=active]:shadow-sm',
        className,
      )}
      {...props}
    />
  );
}

interface TabsContentProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content> {
  ref?: React.Ref<React.ElementRef<typeof TabsPrimitive.Content>>;
}

function TabsContent({ className, ref, ...props }: TabsContentProps) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn(
        'mt-2 ring-offset-bolt-elements-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-ring focus-visible:ring-offset-2',
        className,
      )}
      {...props}
    />
  );
}

export { TabsList, TabsTrigger, TabsContent };
