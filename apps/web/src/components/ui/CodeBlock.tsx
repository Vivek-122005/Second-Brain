import { Check, Copy } from 'lucide-react';
import { useCopy } from '../../lib/clipboard';
import { cn } from '../../lib/cn';

/** Monospace block with a copy button. */
export function CodeBlock({
  code,
  label,
  className,
}: {
  code: string;
  /** Accessible name for the copy button, e.g. "Copy Cursor config". */
  label: string;
  className?: string;
}) {
  const { copied, failed, copy } = useCopy();
  return (
    <div className={cn('relative rounded-[10px] bg-code ring-1 ring-separator', className)}>
      <pre className="overflow-x-auto px-4 py-3 pr-24 font-mono text-[12.5px] leading-relaxed text-label">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={() => copy(code)}
        aria-label={label}
        className="absolute top-2 right-2 inline-flex h-7 items-center gap-1.5 rounded-[7px] bg-elevated px-2.5 text-[12px] font-medium text-label shadow-soft ring-1 ring-separator hover:bg-hover"
      >
        {copied ? (
          <Check aria-hidden className="size-3.5 text-green" strokeWidth={2.25} />
        ) : (
          <Copy aria-hidden className="size-3.5" strokeWidth={1.75} />
        )}
        <span aria-hidden>{copied ? 'Copied' : failed ? 'Copy failed' : 'Copy'}</span>
      </button>
      <span role="status" className="sr-only">
        {copied ? 'Copied to clipboard' : failed ? 'Could not copy' : ''}
      </span>
    </div>
  );
}
