import { newId } from '@second-brain/core';
import type { ApiKey, KeyScope } from '@second-brain/schema';
import { hmacHex, randomToken, timingSafeEqual } from '../lib/crypto';

/**
 * API keys (FR-IAM-02/03): one per machine and assistant, scoped, shown once, stored only as an
 * HMAC-SHA256 hash with a server-side pepper, and revocable immediately (checked on every request).
 */

export interface ApiKeyRow {
  id: string;
  user_id: string;
  label: string;
  machine: string | null;
  client: string | null;
  prefix: string;
  hash: string;
  scopes: string;
  space_id: string | null;
  project_slug: string | null;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

const PREFIX_LEN = 12; // "sb_live_" + 4 characters

export interface CreateKeyInput {
  userId: string;
  label: string;
  machine?: string | undefined;
  client?: string | undefined;
  scopes: KeyScope[];
  spaceId?: string | null | undefined;
  project?: string | null | undefined;
  expiresInDays?: number | undefined;
}

export async function createKey(
  db: D1Database,
  pepper: string,
  input: CreateKeyInput,
): Promise<{ key: ApiKey; secret: string }> {
  const secret = `sb_live_${randomToken(40)}`;
  const now = Date.now();
  const row: ApiKeyRow = {
    id: newId('key'),
    user_id: input.userId,
    label: input.label,
    machine: input.machine ?? null,
    client: input.client ?? null,
    prefix: secret.slice(0, PREFIX_LEN),
    hash: await hmacHex(pepper, secret),
    scopes: JSON.stringify([...new Set(input.scopes)].sort()),
    space_id: input.spaceId ?? null,
    project_slug: input.project ?? null,
    expires_at: input.expiresInDays ? now + input.expiresInDays * 86_400_000 : null,
    last_used_at: null,
    revoked_at: null,
    created_at: now,
  };
  await db
    .prepare(
      `INSERT INTO api_keys (id, user_id, label, machine, client, prefix, hash, scopes, space_id, project_slug,
                             expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.user_id,
      row.label,
      row.machine,
      row.client,
      row.prefix,
      row.hash,
      row.scopes,
      row.space_id,
      row.project_slug,
      row.expires_at,
      row.created_at,
    )
    .run();
  return { key: toApiKey(row), secret };
}

/** Returns the key row for a valid, unrevoked, unexpired secret, else null. */
export async function verifyKey(
  db: D1Database,
  pepper: string,
  secret: string,
): Promise<ApiKeyRow | null> {
  if (!/^sb_live_[A-Za-z0-9]{20,}$/.test(secret)) return null;
  const candidates = await db
    .prepare('SELECT * FROM api_keys WHERE prefix = ? AND revoked_at IS NULL')
    .bind(secret.slice(0, PREFIX_LEN))
    .all<ApiKeyRow>();
  const hash = await hmacHex(pepper, secret);
  const now = Date.now();
  for (const row of candidates.results) {
    if (timingSafeEqual(row.hash, hash) && (row.expires_at === null || row.expires_at > now))
      return row;
  }
  return null;
}

/** Records use at most every 5 minutes to keep writes off the hot path. */
export async function touchKey(db: D1Database, row: ApiKeyRow): Promise<void> {
  const now = Date.now();
  if (row.last_used_at && now - row.last_used_at < 300_000) return;
  await db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(now, row.id).run();
}

export async function listKeys(db: D1Database, userId: string): Promise<ApiKey[]> {
  const r = await db
    .prepare(
      'SELECT * FROM api_keys WHERE user_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC',
    )
    .bind(userId)
    .all<ApiKeyRow>();
  return r.results.map(toApiKey);
}

export async function revokeKey(db: D1Database, userId: string, keyId: string): Promise<boolean> {
  const r = await db
    .prepare(
      'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    )
    .bind(Date.now(), keyId, userId)
    .run();
  return r.meta.changes === 1;
}

export function parseScopes(json: string): KeyScope[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((s): s is KeyScope => s === 'read' || s === 'write') : [];
  } catch {
    return [];
  }
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    label: row.label,
    machine: row.machine,
    client: row.client,
    prefix: row.prefix,
    scopes: parseScopes(row.scopes),
    space_id: row.space_id,
    project: row.project_slug,
    created_at: new Date(row.created_at).toISOString(),
    last_used_at: iso(row.last_used_at),
    expires_at: iso(row.expires_at),
    revoked_at: iso(row.revoked_at),
  };
}
