import { useRef, type KeyboardEvent } from 'react';
import { cn } from '../../lib/cn';

export interface Segment<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
  className?: string;
  size?: 'sm' | 'md';
}

/**
 * iOS-style segmented control. Implemented as a radio group: Tab moves into the control, arrow
 * keys move the selection (WAI-ARIA radio group pattern).
 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  label,
  className,
  size = 'md',
}: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % segments.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = (index - 1 + segments.length) % segments.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = segments.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const seg = segments[next];
    if (seg) onChange(seg.value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'inline-flex rounded-[9px] bg-fill p-0.5',
        size === 'sm' ? 'text-[12px]' : 'text-[13px]',
        className,
      )}
    >
      {segments.map((seg, i) => {
        const selected = seg.value === value;
        return (
          <button
            key={seg.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(seg.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'flex-1 rounded-[7px] font-medium whitespace-nowrap transition-[background-color,box-shadow,color] duration-150',
              size === 'sm' ? 'h-6 px-2.5' : 'h-7 px-3',
              selected
                ? 'bg-elevated text-label shadow-[0_1px_3px_rgb(0_0_0/0.12),0_0_0_0.5px_rgb(0_0_0/0.04)]'
                : 'text-label-secondary hover:text-label',
            )}
          >
            {seg.label}
          </button>
        );
      })}
    </div>
  );
}
