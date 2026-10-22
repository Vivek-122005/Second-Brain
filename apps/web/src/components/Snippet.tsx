/**
 * Renders a search snippet. The server marks matches as `**…**`; we turn those into <mark>
 * elements as React text nodes (never as HTML), so note content cannot inject markup.
 */
export function Snippet({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return (
    <span className={className}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="hit">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}
