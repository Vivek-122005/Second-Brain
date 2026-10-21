import type { DeviceRequestInfo, KeyScope } from '@second-brain/schema';
import { randomToken, sha256Hex, userCode } from '../lib/crypto';

/**
 * Device authorization for the CLI (RFC 8628 shape, ADR-0007). The CLI gets a device code and a
 * short user code; the user approves in the browser; the CLI's next poll mints an API key. The
 * key secret is created at poll time and never stored, only returned once.
 */

export const DEVICE_TTL_MS = 10 * 60_000;
export const DEVICE_INTERVAL_S = 5;

export interface DeviceCodeRow {
  device_code_hash: string;
  user_code: string;
  client: string;
  machine: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed';
  user_id: string | null;
  scopes: string | null;
  project_slug: string | null;
  created_at: number;
  expires_at: number;
  last_polled_at: number | null;
}

export async function startDevice(
  db: D1Database,
  client: string,
  machine: string,
): Promise<{ deviceCode: string; userCode: string; expiresAt: number }> {
  const deviceCode = randomToken(43);
  const code = userCode();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO device_codes (device_code_hash, user_code, client, machine, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(await sha256Hex(deviceCode), code, client, machine, now, now + DEVICE_TTL_MS)
    .run();
  return { deviceCode, userCode: code, expiresAt: now + DEVICE_TTL_MS };
}

export function normalizeUserCode(code: string): string {
  const s = code.toUpperCase().replace(/[^A-Z]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : code.toUpperCase();
}

export async function getPendingByUserCode(
  db: D1Database,
  code: string,
): Promise<DeviceCodeRow | null> {
  const row = await db
    .prepare("SELECT * FROM device_codes WHERE user_code = ? AND status = 'pending'")
    .bind(normalizeUserCode(code))
    .first<DeviceCodeRow>();
  if (!row || row.expires_at <= Date.now()) return null;
  return row;
}

export function toDeviceInfo(row: DeviceCodeRow): DeviceRequestInfo {
  return {
    user_code: row.user_code,
    client: row.client,
    machine: row.machine,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
  };
}

export async function decideDevice(
  db: D1Database,
  code: string,
  userId: string,
  approve: boolean,
  scopes: KeyScope[],
  project: string | null,
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE device_codes SET status = ?1, user_id = ?2, scopes = ?3, project_slug = ?4
       WHERE user_code = ?5 AND status = 'pending' AND expires_at > ?6`,
    )
    .bind(
      approve ? 'approved' : 'denied',
      userId,
      JSON.stringify(scopes),
      project,
      normalizeUserCode(code),
      Date.now(),
    )
    .run();
  return r.meta.changes === 1;
}

export type PollResult =
  | { state: 'pending' }
  | { state: 'slow_down' }
  | { state: 'denied' }
  | { state: 'expired' }
  | { state: 'approved'; row: DeviceCodeRow };

/** One poll. An approved code is consumed atomically so only one poll can mint the key. */
export async function pollDevice(db: D1Database, deviceCode: string): Promise<PollResult> {
  const hash = await sha256Hex(deviceCode);
  const now = Date.now();
  const row = await db
    .prepare('SELECT * FROM device_codes WHERE device_code_hash = ?')
    .bind(hash)
    .first<DeviceCodeRow>();
  if (!row || row.expires_at <= now || row.status === 'consumed') return { state: 'expired' };
  if (row.status === 'denied') return { state: 'denied' };
  if (row.status === 'pending') {
    const tooFast =
      row.last_polled_at !== null && now - row.last_polled_at < (DEVICE_INTERVAL_S - 1) * 1000;
    await db
      .prepare('UPDATE device_codes SET last_polled_at = ? WHERE device_code_hash = ?')
      .bind(now, hash)
      .run();
    return tooFast ? { state: 'slow_down' } : { state: 'pending' };
  }
  const consumed = await db
    .prepare(
      "UPDATE device_codes SET status = 'consumed' WHERE device_code_hash = ? AND status = 'approved'",
    )
    .bind(hash)
    .run();
  if (consumed.meta.changes !== 1) return { state: 'expired' };
  return { state: 'approved', row };
}
