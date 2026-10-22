import { rebuildIndex } from '@second-brain/db';
import { Hono } from 'hono';
import { type AppEnv, identify, requireScope } from './auth/principal';
import type { Env } from './env';
import { HttpError, problem } from './lib/http';
import { handleMcp } from './mcp/server';
import { bearerChallenge, oauthApiRoutes, oauthRoutes, purgeExpiredOAuth } from './oauth';
import { apiRoutes } from './routes/api';
import { authRoutes } from './routes/auth';
import { grantRoutes } from './routes/grants';
import { vaultRoutes } from './routes/vault';
import type { SpaceRow } from './services/spaces';
import { vaultFor } from './vault';
import { driftCheck } from './vault/sync';
import { githubWebhooks } from './webhooks/github';

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
app.route('/', oauthRoutes);
// Reads of a GitHub space trigger a cheap catch-up when its last sync check is stale.
app.use('/api/*', driftCheck);
app.use('/mcp', driftCheck);
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/oauth', oauthApiRoutes);
app.route('/api/v1', apiRoutes);
app.route('/api/v1', grantRoutes);
app.route('/api/v1', vaultRoutes);
app.route('/webhooks/github', githubWebhooks);

// MCP over Streamable HTTP (stateless). Requires an API key or an OAuth access token with at
// least the read scope. The 401 challenge points clients at our OAuth metadata (RFC 9728).
app.all('/mcp', async (c) => {
  const p = c.get('principal');
  if (!p || (p.via !== 'key' && p.via !== 'oauth')) {
    const sentToken = /^bearer /i.test(c.req.header('authorization') ?? '');
    return c.json(
      {
        error: sentToken ? 'invalid_token' : 'unauthorized',
        message:
          'Connect with OAuth, or send Authorization: Bearer <API key>. Create keys with `brain login` or in the web app.',
      },
      401,
      {
        'www-authenticate': bearerChallenge(
          new URL(c.req.url).origin,
          sentToken ? 'invalid_token' : undefined,
        ),
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
    ctx.waitUntil(purgeExpiredOAuth(env.DB));
  },
} satisfies ExportedHandler<Env>;
