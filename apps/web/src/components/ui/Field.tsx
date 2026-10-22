import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { cn } from '../../lib/cn';

const control =
  'h-10 w-full rounded-[9px] border border-field-border bg-canvas px-3 text-[15px] text-label transition-[border-color,box-shadow] duration-150 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-tint)] focus:outline-none aria-[invalid=true]:border-red';

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
}

function FieldShell({ label, hint, error, children }: FieldShellProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium text-label">
        {label}
      </label>
      {children({ id, describedBy: describedBy || undefined })}
      {hint ? (
        <p id={hintId} className="text-[12px] leading-snug text-label-secondary">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-[12px] text-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, className, ...props },
  ref,
) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <input
          ref={ref}
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={cn(control, className)}
          {...props}
        />
      )}
    </FieldShell>
  );
});

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}

export function SelectField({ label, hint, className, children, ...props }: SelectFieldProps) {
  return (
    <FieldShell label={label} hint={hint}>
      {({ id, describedBy }) => (
        <select
          id={id}
          aria-describedby={describedBy}
          className={cn(control, 'appearance-auto pr-8', className)}
          {...props}
        >
          {children}
        </select>
      )}
    </FieldShell>
  );
}
