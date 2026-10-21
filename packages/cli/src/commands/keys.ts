import type { ApiKey } from '@second-brain/schema';
import type { Ctx } from '../context';
import { relativeTime, truncate, type Output } from '../output';
import { requireSession } from '../session';

export function keyStatus(key: ApiKey, now: number): 'active' | 'revoked' | 'expired' {
  if (key.revoked_at) return 'revoked';
  if (key.expires_at && Date.parse(key.expires_at) <= now) return 'expired';
  return 'active';
}

export async function keys(ctx: Ctx, out: Output, opts: { api?: string }): Promise<void> {
  const s = await requireSession(ctx, out, opts.api);
  const items = await s.api.listKeys();
  if (items.length === 0) {
    out.line('No API keys.');
    return;
  }
  const now = ctx.now();
  const order = { active: 0, expired: 1, revoked: 2 } as const;
  items.sort(
    (a, b) =>
      order[keyStatus(a, now)] - order[keyStatus(b, now)] ||
      (b.last_used_at ?? b.created_at).localeCompare(a.last_used_at ?? a.created_at),
  );

  const rows = items.map((k) => {
    const st = keyStatus(k, now);
    const current = k.id === s.key?.id;
    const statusText =
      st === 'active' ? out.c.green(st) : st === 'revoked' ? out.c.red(st) : out.c.yellow(st);
    return [
      `${k.prefix}…${current ? out.c.cyan(' *') : ''}`,
      truncate(k.label, 32),
      k.client ?? '-',
      truncate(k.machine ?? '-', 24),
      relativeTime(k.last_used_at, now),
      statusText,
    ];
  });
  out.table(['PREFIX', 'LABEL', 'CLIENT', 'MACHINE', 'LAST USED', 'STATUS'], rows);
  if (s.key && items.some((k) => k.id === s.key?.id)) {
    out.line(out.c.dim('* this machine’s login key'));
  }
}
