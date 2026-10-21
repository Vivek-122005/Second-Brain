import { createColors } from 'picocolors';
import type { Ctx, OutStream } from './context';

export type Colors = ReturnType<typeof createColors>;

/** `sb_live_ab12…`: what we show instead of a secret. */
export function maskSecret(secret: string, prefix?: string | null): string {
  if (prefix && secret.startsWith(prefix)) return `${prefix}…`;
  const m = /^(sb_(?:live|test)_)/.exec(secret);
  const visible = m ? m[1]!.length + 4 : 4;
  return `${secret.slice(0, Math.min(visible, Math.floor(secret.length / 3)))}…`;
}

/**
 * Terminal output. Every line goes through a scrubber that replaces any registered secret with its
 * masked form, so a secret can only reach the terminal through the explicit `sensitive()` call.
 */
export class Output {
  readonly c: Colors;
  private readonly secrets = new Map<string, string>();

  constructor(
    private readonly stdout: OutStream,
    private readonly stderr: OutStream,
    color: boolean,
  ) {
    this.c = createColors(color);
  }

  static fromCtx(ctx: Ctx): Output {
    const env = ctx.env;
    const color =
      env.NO_COLOR === undefined &&
      env.TERM !== 'dumb' &&
      (env.FORCE_COLOR !== undefined ? env.FORCE_COLOR !== '0' : Boolean(ctx.stdout.isTTY));
    return new Output(ctx.stdout, ctx.stderr, color);
  }

  /** Never print this value; show its masked form instead. */
  registerSecret(secret: string, prefix?: string | null): void {
    if (secret.length >= 8) this.secrets.set(secret, maskSecret(secret, prefix));
  }

  scrub(text: string): string {
    let out = text;
    for (const [secret, masked] of this.secrets) out = out.split(secret).join(masked);
    return out;
  }

  line(text = ''): void {
    this.stdout.write(this.scrub(text) + '\n');
  }

  /** Prints text that intentionally contains a secret (only behind `--show-secret`). */
  sensitive(text: string): void {
    this.stdout.write(text + '\n');
  }

  info(text: string): void {
    this.line(text);
  }

  success(text: string): void {
    this.line(`${this.c.green('✓')} ${text}`);
  }

  warn(text: string): void {
    this.stderr.write(this.scrub(`${this.c.yellow('!')} ${text}`) + '\n');
  }

  error(text: string, hint?: string): void {
    this.stderr.write(this.scrub(`${this.c.red('error')} ${text}`) + '\n');
    if (hint) this.stderr.write(this.scrub(`      ${this.c.dim(hint)}`) + '\n');
  }

  /** Aligned `label  value` pairs. */
  fields(rows: [string, string][]): void {
    const width = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) this.line(`  ${this.c.dim(k.padEnd(width))}  ${v}`);
  }

  table(headers: string[], rows: string[][]): void {
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => visibleLength(r[i] ?? ''))),
    );
    const fmt = (cells: string[]) =>
      cells
        .map((cell, i) =>
          i === cells.length - 1 ? cell : cell + ' '.repeat((widths[i] ?? 0) - visibleLength(cell)),
        )
        .join('  ')
        .trimEnd();
    this.line(this.c.dim(fmt(headers)));
    for (const r of rows) this.line(fmt(r));
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
function visibleLength(s: string): number {
  return s.replace(ANSI, '').length;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", or the date for anything older than 30 days. */
export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.round((now - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** Replaces the home directory with `~` for display. */
export function tildify(p: string, home: string): string {
  return home && (p === home || p.startsWith(home + '/') || p.startsWith(home + '\\'))
    ? '~' + p.slice(home.length)
    : p;
}

/** Quotes an argument for display in a POSIX shell command line. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
