import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import type { Env } from '../env';
import { toHex, timingSafeEqual } from '../lib/crypto';
import { audit } from '../services/audit';
import type { SpaceRow } from '../services/spaces';
import { githubVaultFor, openSpaceSecret } from '../vault';
import {
  getSyncState,
  logSyncError,
  markSyncError,
  syncBetween,
  syncFull,
  syncPaths,
  type SyncResult,
} from '../vault/sync';

/**
 * `POST /webhooks/github/:spaceId`: GitHub push webhooks for spaces whose vault is a GitHub repo
 * (HLD §4.3, FR-VLT-07, security.md §1).
 *
 * 1. Verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the space's webhook secret)
 *    with a constant-time compare. Nothing else is trusted before this.
 * 2. Dedupe by `X-GitHub-Delivery`, so a redelivered or replayed event is processed once.
 * 3. `ping` → 200. `push` to the tracked branch → 202, then re-index only the changed Markdown
 *    paths in `ctx.waitUntil` (ADR-0008: no queues in v1). Pushes whose head is already indexed
 *    (our own commits, which are indexed at write time) are skipped.
 */
export const githubWebhooks = new Hono<AppEnv>();

/** GitHub caps webhook payloads at 25 MB. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;
/** Delivery ids are kept this long for dedupe. */
const DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Push payloads list at most this many commits; at or above it, ask the compare API instead. */
const PAYLOAD_COMMIT_LIMIT = 20;
const ZERO_SHA = /^0{40}$/;

const PushEvent = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  created: z.boolean().optional(),
  deleted: z.boolean().optional(),
  forced: z.boolean().optional(),
  repository: z.object({ full_name: z.string() }),
  commits: z
    .array(
      z.object({
        id: z.string(),
        added: z.array(z.string()).optional(),
        removed: z.array(z.string()).optional(),
        modified: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});
type PushEvent = z.infer<typeof PushEvent>;

type WebhookSpace = SpaceRow & { webhook_id: number | null };

const ack = (status: string, extra: Record<string, unknown> = {}) => ({ status, ...extra });

githubWebhooks.post('/:spaceId', async (c) => {
  const length = Number(c.req.header('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return c.json(ack('too_large'), 413);

  const space = await c.env.DB.prepare('SELECT * FROM spaces WHERE id = ?')
    .bind(c.req.param('spaceId'))
    .first<WebhookSpace>();
  // Same answer for "no such space" and "not a GitHub space": don't reveal which ids exist.
  if (!space || space.vault_provider !== 'github' || !space.webhook_secret_enc) {
    return c.json(ack('not_found'), 404);
  }

  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) return c.json(ack('too_large'), 413);
  const secret = await openSpaceSecret(c.env, space.id, 'webhook_secret', space.webhook_secret_enc);
  const expected = `sha256=${await hmacSha256Hex(secret, body)}`;
  const given = c.req.header('x-hub-signature-256') ?? '';
  if (!timingSafeEqual(given, expected)) return c.json(ack('invalid_signature'), 401);

  const delivery = c.req.header('x-github-delivery');
  const event = c.req.header('x-github-event') ?? '';
  if (!delivery || delivery.length > 100) return c.json(ack('missing_delivery_id'), 400);

  const now = Date.now();
  const fresh = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO webhook_deliveries (space_id, delivery_id, event, received_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (space_id, delivery_id) DO NOTHING`,
    ).bind(space.id, delivery, event.slice(0, 40), now),
    c.env.DB.prepare('UPDATE spaces SET webhook_last_delivery_at = ? WHERE id = ?').bind(
      now,
      space.id,
    ),
  ]);
  if ((fresh[0]?.meta.changes ?? 0) === 0) return c.json(ack('duplicate'), 200);
  c.executionCtx.waitUntil(
    c.env.DB.prepare('DELETE FROM webhook_deliveries WHERE space_id = ? AND received_at < ?')
      .bind(space.id, now - DELIVERY_TTL_MS)
      .run(),
  );

  if (event === 'ping') return c.json(ack('pong'), 200);
  if (event !== 'push') return c.json(ack('ignored', { reason: 'event' }), 202);

  let push: PushEvent;
  try {
    push = PushEvent.parse(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return c.json(ack('invalid_payload'), 400);
  }
  if (push.repository.full_name.toLowerCase() !== (space.vault_repo ?? '').toLowerCase()) {
    return c.json(ack('ignored', { reason: 'repository' }), 202);
  }
  if (push.ref !== `refs/heads/${space.vault_branch ?? 'main'}`) {
    return c.json(ack('ignored', { reason: 'branch' }), 202);
  }
  if (push.deleted || ZERO_SHA.test(push.after)) {
    // The tracked branch was deleted. Keep the index as it is; the owner has to fix the repo.
    return c.json(ack('ignored', { reason: 'branch_deleted' }), 202);
  }
  const state = await getSyncState(c.env.DB, space.id);
  if (state?.last_indexed_sha === push.after) {
    return c.json(ack('skipped', { reason: 'already_indexed' }), 202);
  }

  c.executionCtx.waitUntil(syncFromPush(c.env, space, push, delivery, state?.last_indexed_sha));
  return c.json(ack('accepted'), 202);
});

/** Changed paths listed in the payload, or null when the list may be incomplete. */
export function payloadPaths(push: PushEvent): string[] | null {
  if (push.commits.length === 0 || push.commits.length >= PAYLOAD_COMMIT_LIMIT) return null;
  const paths = new Set<string>();
  for (const commit of push.commits) {
    if (!commit.added || !commit.removed || !commit.modified) return null;
    for (const p of [...commit.added, ...commit.removed, ...commit.modified]) paths.add(p);
  }
  return [...paths];
}

async function syncFromPush(
  env: Env,
  space: WebhookSpace,
  push: PushEvent,
  delivery: string,
  indexed: string | null | undefined,
): Promise<void> {
  try {
    const vault = await githubVaultFor(env, space);
    let result: SyncResult;
    const listed = payloadPaths(push);
    if (push.forced || push.created || ZERO_SHA.test(push.before)) {
      result = await syncFull(env, vault, space.id);
    } else if (indexed === push.before && listed) {
      // The usual case: the index is at `before` and the payload lists every touched path.
      result = await syncPaths(env, vault, space.id, listed, push.after);
    } else {
      // We missed a push, or the payload's list is truncated: diff from what we have indexed.
      result = await syncBetween(env, vault, space.id, indexed ?? null, push.after);
    }
    await audit(env.DB, {
      spaceId: space.id,
      actorUserId: null,
      actorKeyId: null,
      action: 'vault.github.sync',
      target: push.after,
      metadata: {
        trigger: 'webhook',
        delivery,
        mode: result.mode,
        indexed: result.indexed,
        removed: result.removed,
      },
    });
  } catch (err) {
    await markSyncError(env.DB, space.id, err);
    logSyncError(space.id, 'webhook', err);
  }
}

async function hmacSha256Hex(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, body)));
}
