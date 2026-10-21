import { appendFile, chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { redactDeep } from '@second-brain/core';

/**
 * Local activity spool (LLD §7, FR-ACT-01/02/04). Hooks append agent events as JSONL to
 * `<home>/spool/<YYYY-MM-DD>.jsonl`; a background sender (not built yet; it needs the server's
 * `/api/v1/activity/batch`) will batch and ship them.
 *
 * Guarantees:
 * - Every string in an event is redacted with `redactDeep` before it touches the disk.
 * - The spool never grows past `maxBytes` (default 50 MB): the oldest day files are dropped first,
 *   and if today's file alone is full the event is dropped rather than blocking the agent.
 * - `appendEvent` never throws; hooks are fire-and-forget.
 */

export const SPOOL_MAX_BYTES = 50 * 1024 * 1024;

export interface SpoolOptions {
  /** Spool directory, normally `~/.second-brain/spool`. */
  dir: string;
  maxBytes?: number;
  now?: () => Date;
}

export type SpoolEvent = Record<string, unknown>;

export type AppendResult =
  | { written: true; file: string; redactions: number; dropped: string[] }
  | { written: false; reason: 'cap' | 'error'; error?: string; dropped: string[] };

const FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export function spoolDir(brainHome: string): string {
  return path.join(brainHome, 'spool');
}

function dayFile(date: Date): string {
  return `${date.toISOString().slice(0, 10)}.jsonl`;
}

/** Day files with their sizes, oldest first. */
export async function listSpoolFiles(dir: string): Promise<{ name: string; size: number }[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => FILE_RE.test(n)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const files = [];
  for (const name of names) {
    const s = await stat(path.join(dir, name)).catch(() => null);
    if (s) files.push({ name, size: s.size });
  }
  return files;
}

export async function appendEvent(event: SpoolEvent, opts: SpoolOptions): Promise<AppendResult> {
  const dropped: string[] = [];
  try {
    const now = (opts.now ?? (() => new Date()))();
    const maxBytes = opts.maxBytes ?? SPOOL_MAX_BYTES;
    const { value, count } = redactDeep({ ts: now.toISOString(), ...event });
    const line = JSON.stringify(value) + '\n';
    const bytes = Buffer.byteLength(line);

    await mkdir(opts.dir, { recursive: true, mode: 0o700 });
    const today = dayFile(now);
    const files = await listSpoolFiles(opts.dir);
    let total = files.reduce((sum, f) => sum + f.size, 0);

    // Make room by dropping whole days, oldest first, but never today's file.
    for (const f of files) {
      if (total + bytes <= maxBytes) break;
      if (f.name >= today) continue;
      await rm(path.join(opts.dir, f.name), { force: true });
      total -= f.size;
      dropped.push(f.name);
    }
    if (total + bytes > maxBytes) return { written: false, reason: 'cap', dropped };

    const file = path.join(opts.dir, today);
    await appendFile(file, line, { mode: 0o600 });
    await chmod(file, 0o600);
    return { written: true, file, redactions: count, dropped };
  } catch (err) {
    return { written: false, reason: 'error', error: (err as Error).message, dropped };
  }
}
