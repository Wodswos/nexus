import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../utils';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  color?: string;
  disabled?: boolean;
}

interface SelectFieldProps {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  'aria-label': string;
  id?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  onCloseAutoFocus?: (event: Event) => void;
}

/** The same keyboard-accessible option surface in task, project and filter settings. */
export const SelectField = React.forwardRef<HTMLButtonElement, SelectFieldProps>(
  ({ value, onValueChange, options, className, placeholder, onCloseAutoFocus, ...props }, ref) => {
    // Radix reserves the empty value for its placeholder; callers still use '' for “all”.
    const empty = React.useId();
    const selected = options.find((option) => option.value === value);
    return (
      <SelectPrimitive.Root
        value={value || empty}
        onValueChange={(next) => onValueChange(next === empty ? '' : next)}
        disabled={props.disabled}
      >
        <SelectPrimitive.Trigger
          {...props}
          ref={ref}
          data-value={value}
          className={cn(
            'inline-flex h-9 min-w-0 items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-left text-xs text-foreground outline-none transition-colors hover:border-[var(--border-strong)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected?.color && (
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: selected.color }}
              />
            )}
            <SelectPrimitive.Value placeholder={placeholder}>
              <span className="block truncate">{selected?.label ?? placeholder}</span>
            </SelectPrimitive.Value>
          </span>
          <SelectPrimitive.Icon>
            <ChevronDown size={13} className="shrink-0 text-muted" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            data-select-content
            data-control-layer
            data-task-detail-portal
            position="popper"
            sideOffset={6}
            collisionPadding={12}
            onCloseAutoFocus={onCloseAutoFocus}
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.stopPropagation();
            }}
            className="z-[80] max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[max(180px,var(--radix-select-trigger-width))] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)] p-1.5 text-foreground shadow-[0_12px_40px_rgb(0_0_0/0.14)] outline-none"
          >
            <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-muted">
              <ChevronUp size={14} />
            </SelectPrimitive.ScrollUpButton>
            <SelectPrimitive.Viewport>
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value || empty}
                  disabled={option.disabled}
                  data-value={option.value}
                  className="relative flex min-h-10 cursor-default select-none items-center gap-2.5 rounded-lg py-2 pl-2.5 pr-8 outline-none data-[highlighted]:bg-[var(--surface)] data-[state=checked]:bg-[var(--selection)] data-[state=checked]:text-[var(--accent-solid)] data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
                >
                  {option.color && (
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: option.color }}
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <SelectPrimitive.ItemText>
                      <span className="block text-[13px] leading-5">{option.label}</span>
                    </SelectPrimitive.ItemText>
                    {option.description && (
                      <span className="mt-0.5 block text-[11px] leading-4 text-muted">
                        {option.description}
                      </span>
                    )}
                  </span>
                  <SelectPrimitive.ItemIndicator className="absolute right-2.5">
                    <Check size={14} />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
            <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center text-muted">
              <ChevronDown size={14} />
            </SelectPrimitive.ScrollDownButton>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    );
  },
);
SelectField.displayName = 'SelectField';
