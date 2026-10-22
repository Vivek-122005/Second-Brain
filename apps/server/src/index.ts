import { rebuildIndex } from '@second-brain/db';
import { Hono } from 'hono';
import { type AppEnv, identify, requireScope } from './auth/principal';
import type { Env } from './env';
import { HttpError, problem } from './lib/http';
import { handleMcp } from './mcp/server';
import { apiRoutes } from './routes/api';
import { authRoutes } from './routes/auth';
import { grantRoutes } from './routes/grants';
import type { SpaceRow } from './services/spaces';
import { vaultFor } from './vault';

export const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
  c.header('x-request-id', c.get('requestId'));
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
});

app.get('/health', (c) => c.json({ ok: true }));

app.use('/api/*', identify);
app.use('/mcp', identify);
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1', apiRoutes);
app.route('/api/v1', grantRoutes);

// MCP over Streamable HTTP (stateless). Requires an API key with at least the read scope.
app.all('/mcp', async (c) => {
  const p = c.get('principal');
  if (!p || p.via !== 'key') {
    return c.json(
      {
        error: 'unauthorized',
        message:
          'Send Authorization: Bearer <API key>. Create keys with `brain login` or in the web app.',
      },
      401,
      {
        'www-authenticate': 'Bearer realm="second-brain"',
      },
    );
  }
  requireScope(p, 'read');
  return handleMcp(c.env, p, c.req.raw);
});

app.notFound((c) => problem(c, new HttpError(404, 'Not found', 'No such endpoint.')));

app.onError((err, c) => {
  if (err instanceof HttpError) return problem(c, err);
  // Log the error class and request id only: never note content, queries or secrets (NFR-09).
  console.error(
    JSON.stringify({
      level: 'error',
      request_id: c.get('requestId'),
      error: err.name,
      message: err.message.slice(0, 200),
    }),
  );
  return problem(c, new HttpError(500, 'Internal error', 'Something went wrong. Please retry.'));
});

/** Nightly full rebuild of every space's index from its vault (HLD §4.4, NFR-04). */
export async function rebuildAll(env: Env): Promise<{ spaces: number }> {
  const spaces = await env.DB.prepare('SELECT * FROM spaces').all<SpaceRow>();
  for (const space of spaces.results) {
    try {
      const vault = await vaultFor(env, space);
      const [head, files] = await Promise.all([vault.head(), vault.readAll()]);
      await rebuildIndex(
        env.DB,
        space.id,
        files.map((f) => ({ path: f.path, content: f.content })),
        head,
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          job: 'rebuild',
          space: space.id,
          message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        }),
      );
    }
  }
  return { spaces: spaces.results.length };
}

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(rebuildAll(env));
  },
} satisfies ExportedHandler<Env>;
