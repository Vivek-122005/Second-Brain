import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, listSpoolFiles } from '../src/spool';

let dir: string;
beforeEach(async () => {
  dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'brain-spool-')), 'spool');
});
afterEach(async () => {
  await rm(path.dirname(dir), { recursive: true, force: true });
});

const at = (iso: string) => () => new Date(iso);

describe('appendEvent', () => {
  it('appends redacted JSONL to the day file with mode 0600', async () => {
    const now = at('2026-10-21T09:30:00.000Z');
    const res = await appendEvent(
      {
        type: 'tool_call',
        tool: 'Bash',
        input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop1234567890"' },
        notes: ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', 'fine'],
        n: 3,
      },
      { dir, now },
    );
    expect(res.written).toBe(true);
    if (!res.written) return;
    expect(res.redactions).toBe(2);
    expect(path.basename(res.file)).toBe('2026-10-21.jsonl');
    expect((await stat(res.file)).mode & 0o777).toBe(0o600);

    await appendEvent({ type: 'second' }, { dir, now });
    const lines = (await readFile(res.file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.ts).toBe('2026-10-21T09:30:00.000Z');
    expect(first.n).toBe(3);
    expect(first.input.command).toContain('[REDACTED:bearer-token]');
    expect(first.notes[0]).toBe('token [REDACTED:github-token]');
    expect(first.notes[1]).toBe('fine');
    expect(lines.join('\n')).not.toContain('ghp_abcdefghijklmnop');
    expect(lines.join('\n')).not.toContain('abcdefghijklmnop1234567890');
  });

  it('redacts Second Brain keys too', async () => {
    const res = await appendEvent(
      { output: 'key=sb_live_ab12CDefGhijKLmnOPqrSTuvWXyz0123456789' },
      { dir, now: at('2026-10-21T00:00:00Z') },
    );
    expect(res.written).toBe(true);
    const text = await readFile(path.join(dir, '2026-10-21.jsonl'), 'utf8');
    expect(text).not.toContain('sb_live_ab12CDef');
  });

  it('drops the oldest day files to stay under the cap', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '2026-10-18.jsonl'), 'x'.repeat(400));
    await writeFile(path.join(dir, '2026-10-19.jsonl'), 'x'.repeat(400));
    await writeFile(path.join(dir, '2026-10-20.jsonl'), 'x'.repeat(100));
    await writeFile(path.join(dir, 'unrelated.txt'), 'x'.repeat(5000));

    const res = await appendEvent(
      { type: 'e', pad: 'y'.repeat(50) },
      { dir, maxBytes: 1000, now: at('2026-10-21T08:00:00Z') },
    );
    expect(res.written).toBe(true);
    expect(res.dropped).toEqual(['2026-10-18.jsonl']);
    expect((await readdir(dir)).sort()).toEqual([
      '2026-10-19.jsonl',
      '2026-10-20.jsonl',
      '2026-10-21.jsonl',
      'unrelated.txt',
    ]);
    const total = (await listSpoolFiles(dir)).reduce((s, f) => s + f.size, 0);
    expect(total).toBeLessThanOrEqual(1000);
  });

  it("drops the event (never today's file) when today alone is at the cap", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '2026-10-20.jsonl'), 'x'.repeat(10));
    await writeFile(path.join(dir, '2026-10-21.jsonl'), 'x'.repeat(990));
    const res = await appendEvent(
      { type: 'e' },
      { dir, maxBytes: 1000, now: at('2026-10-21T08:00:00Z') },
    );
    expect(res).toMatchObject({ written: false, reason: 'cap', dropped: ['2026-10-20.jsonl'] });
    expect((await stat(path.join(dir, '2026-10-21.jsonl'))).size).toBe(990);
  });

  it('never throws, even when the spool path is unusable', async () => {
    await mkdir(path.dirname(dir), { recursive: true });
    await writeFile(dir, 'not a directory');
    const res = await appendEvent({ type: 'e' }, { dir });
    expect(res).toMatchObject({ written: false, reason: 'error' });
  });
});
