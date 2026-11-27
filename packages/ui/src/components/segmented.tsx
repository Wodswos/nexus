import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../utils';

/** 视图切换器:胶囊式 segmented control */
export const Segmented = TabsPrimitive.Root;

export const SegmentedList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex items-center h-8 gap-0 rounded-[var(--radius-md)] bg-[var(--bg-muted)] p-0.5 no-scrollbar overflow-x-auto max-w-full',
      className,
    )}
    {...props}
  />
));
SegmentedList.displayName = 'SegmentedList';

export const SegmentedTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'whitespace-nowrap rounded-[var(--radius-sm)] px-3 h-7 text-control font-medium text-secondary transition-colors',
      'hover:bg-[var(--bg-hover)] hover:text-foreground',
      'data-[state=active]:bg-[var(--background)] data-[state=active]:text-foreground data-[state=active]:shadow-xs',
      className,
    )}
    {...props}
  />
));
SegmentedTrigger.displayName = 'SegmentedTrigger';

export const SegmentedContent = TabsPrimitive.Content;
