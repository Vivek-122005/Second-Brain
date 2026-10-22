import { ApiError } from '../api';
import { loadConfig, resolveApiUrl } from '../config';
import type { Ctx } from '../context';
import { CliError, ExitCode } from '../errors';
import { tildify, type Output } from '../output';
import { backendLabel } from '../secrets';
import { requireSession, type Session } from '../session';

export async function status(ctx: Ctx, out: Output, opts: { api?: string }): Promise<void> {
  let s: Session;
  try {
    s = await requireSession(ctx, out, opts.api);
  } catch (err) {
    if (err instanceof CliError && err.exitCode === ExitCode.Auth) {
      const apiUrl = resolveApiUrl(ctx, await loadConfig(ctx), opts.api);
      out.fields([
        ['API', apiUrl],
        ['Signed in', 'no'],
      ]);
    }
    throw err;
  }

  const rows: [string, string][] = [
    ['API', s.apiUrl],
    ['MCP', s.mcpUrl],
  ];

  let failure: CliError | undefined;
  try {
    const me = await s.api.me();
    const who = me.user.name ? `${me.user.name} <${me.user.email}>` : me.user.email;
    rows.push(['User', who]);
    const space = me.spaces.find((sp) => sp.id === me.default_space_id);
    if (space) rows.push(['Space', `${space.name} (${space.role})`]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      rows.push(['User', out.c.red('key rejected (revoked or expired)')]);
      failure = new CliError(
        'The server rejected the stored key.',
        ExitCode.Auth,
        'Run `brain login` to sign in again.',
      );
    } else if (err instanceof CliError) {
      const why = err instanceof ApiError ? `server answered ${err.status}` : 'server unreachable';
      rows.push(['User', out.c.yellow(`unknown (${why})`)]);
      failure = err;
    } else {
      throw err;
    }
  }

  const key = s.key;
  rows.push([
    'Key',
    key ? `${key.prefix}…  ${out.c.dim(key.label)}` : out.c.dim('(details unknown)'),
  ]);
  if (key)
    rows.push(['Scopes', key.scopes.join(', ') + (key.project ? ` (project ${key.project})` : '')]);
  rows.push(['Stored in', tildify(backendLabel(ctx, s.backend), ctx.homedir)]);
  const connections = Object.entries(s.cfg.connections ?? {});
  if (connections.length > 0 && s.cfg.api_url === s.apiUrl) {
    rows.push([
      'Connected',
      connections.map(([client, c]) => `${client} (${c.key_prefix}…)`).join(', '),
    ]);
  }
  out.fields(rows);
  if (failure) throw failure;
}
