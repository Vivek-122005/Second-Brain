import * as Tooltip from '@radix-ui/react-tooltip';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { RouterAnchor } from './RouterAnchor';

type Variant = 'primary' | 'secondary' | 'plain' | 'destructive' | 'destructive-plain';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent-fill text-on-accent hover:brightness-110 active:brightness-95 shadow-soft',
  secondary: 'bg-fill text-label hover:bg-fill-strong',
  plain: 'text-accent-text hover:bg-hover',
  // Fixed red in both schemes: white on #D70015 is 5.4:1 (the dark-mode text red is too light).
  destructive: 'bg-[#d70015] text-white hover:brightness-110 active:brightness-95 shadow-soft',
  'destructive-plain': 'text-red hover:bg-red-tint',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[13px] gap-1.5 rounded-[7px]',
  md: 'h-8 px-3.5 text-[14px] gap-2 rounded-control',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-[10px]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center font-medium whitespace-nowrap transition-[background-color,filter,opacity] duration-150 disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name; also shown as the tooltip. */
  label: string;
  /** Optional keyboard shortcut hint for the tooltip, e.g. "⌘N". */
  shortcut?: string;
  children: ReactNode;
  tone?: 'default' | 'accent';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, children, className, tone = 'default', type = 'button', ...props },
  ref,
) {
  return (
    <Tooltip.Root delayDuration={500}>
      <Tooltip.Trigger asChild>
        <button
          ref={ref}
          type={type}
          aria-label={label}
          className={cn(
            'inline-flex size-8 shrink-0 items-center justify-center rounded-control transition-colors duration-150 hover:bg-hover disabled:opacity-40',
            tone === 'accent' ? 'text-accent' : 'text-label-secondary hover:text-label',
            className,
          )}
          {...props}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="bottom"
          sideOffset={6}
          className="animate-fade z-50 rounded-md bg-elevated px-2 py-1 text-[12px] text-label shadow-card ring-1 ring-separator"
        >
          {label}
          {shortcut ? <span className="ml-2 text-label-secondary">{shortcut}</span> : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
});

/** Icon-only in-app link styled like IconButton (e.g. the Edit action). */
export function IconLink({
  label,
  href,
  children,
  className,
}: {
  label: string;
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip.Root delayDuration={500}>
      <Tooltip.Trigger asChild>
        <RouterAnchor
          href={href}
          aria-label={label}
          className={cn(
            'inline-flex size-8 shrink-0 items-center justify-center rounded-control text-label-secondary transition-colors duration-150 hover:bg-hover hover:text-label',
            className,
          )}
        >
          {children}
        </RouterAnchor>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="bottom"
          sideOffset={6}
          className="animate-fade z-50 rounded-md bg-elevated px-2 py-1 text-[12px] text-label shadow-card ring-1 ring-separator"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
