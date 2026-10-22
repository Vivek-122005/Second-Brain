import type { OAuthGrant } from '@second-brain/schema';
import { parseScopes } from '../auth/keys';
import { type OAuthClientRow, redirectHosts } from './clients';
import type { GrantRow } from './tokens';

/** Connected apps: the active OAuth grants of one user, for the web app's settings page. */

type GrantWithClient = GrantRow & Pick<OAuthClientRow, 'name' | 'client_uri' | 'redirect_uris'>;

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export async function listGrants(db: D1Database, userId: string): Promise<OAuthGrant[]> {
  const r = await db
    .prepare(
      `SELECT g.*, c.name, c.client_uri, c.redirect_uris
       FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
       WHERE g.user_id = ? AND g.revoked_at IS NULL
       ORDER BY g.created_at DESC`,
    )
    .bind(userId)
    .all<GrantWithClient>();
  return r.results.map((g) => ({
    id: g.id,
    client_id: g.client_id,
    client_name: g.name,
    client_uri: g.client_uri,
    redirect_hosts: redirectHosts(g),
    scopes: parseScopes(g.scopes),
    space_id: g.space_id,
    created_at: new Date(g.created_at).toISOString(),
    last_used_at: iso(g.last_used_at),
  }));
}

/** Disconnects an app: revokes the grant and every token issued under it, in one batch. */
export async function revokeGrant(
  db: D1Database,
  userId: string,
  grantId: string,
): Promise<boolean> {
  const now = Date.now();
  const [grant] = await db.batch([
    db
      .prepare(
        'UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      )
      .bind(now, grantId, userId),
    db
      .prepare(
        `UPDATE oauth_tokens SET revoked_at = ?
         WHERE grant_id = ? AND user_id = ? AND revoked_at IS NULL`,
      )
      .bind(now, grantId, userId),
  ]);
  return grant?.meta.changes === 1;
}
