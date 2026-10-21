import { afterEach, describe, expect, it } from 'vitest';
import { normalizeApiUrl, resolveApiUrl } from '../src/config';
import { stripJsonc } from '../src/jsonfile';
import { maskSecret, relativeTime } from '../src/output';
import { VERSION } from '../src/version';
import { makeEnv, type TestEnv } from './helpers';

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
});

describe('brain (top level)', () => {
  it('prints the version', async () => {
    env = await makeEnv();
    expect(await env.run('--version')).toBe(0);
    expect(env.stdout().trim()).toBe(VERSION);
  });

  it('prints help with `help`, `--help` and exits 2 with no command', async () => {
    env = await makeEnv();
    expect(await env.run('help')).toBe(0);
    expect(env.stdout()).toMatch(/Commands/);
    expect(await env.run('--help')).toBe(0);
    expect(await env.run()).toBe(2);
  });

  it('shows per-command help', async () => {
    env = await makeEnv();
    expect(await env.run('login', '--help')).toBe(0);
    expect(env.stdout()).toMatch(/--machine <name>/);
  });

  it('rejects unknown commands, options and stray arguments with exit code 2', async () => {
    env = await makeEnv();
    expect(await env.run('logn')).toBe(2);
    expect(env.stderr()).toMatch(/Did you mean `brain login`/);
    expect(await env.run('status', '--bogus')).toBe(2);
    expect(await env.run('status', '--machine', 'x')).toBe(2);
    expect(env.stderr()).toMatch(/does not take --machine/);
    expect(await env.run('keys', 'extra')).toBe(2);
  });
});

describe('helpers', () => {
  it('normalizes API URLs', () => {
    expect(normalizeApiUrl('https://brain.example.com/')).toBe('https://brain.example.com');
    expect(normalizeApiUrl('https://brain.example.com/api/v1/')).toBe('https://brain.example.com');
    expect(normalizeApiUrl('http://localhost:8787?x=1')).toBe('http://localhost:8787');
    expect(() => normalizeApiUrl('nope')).toThrow(/not a valid URL/);
    expect(() => normalizeApiUrl('ftp://x')).toThrow(/http or https/);
  });

  it('resolves the API URL: flag, env, config, default', async () => {
    env = await makeEnv();
    const cfg = { api_url: 'https://saved.example.com' };
    expect(resolveApiUrl(env.ctx, {}, undefined)).toBe('http://localhost:8787');
    expect(resolveApiUrl(env.ctx, cfg, undefined)).toBe('https://saved.example.com');
    env.ctx.env.SECOND_BRAIN_API_URL = 'https://env.example.com';
    expect(resolveApiUrl(env.ctx, cfg, undefined)).toBe('https://env.example.com');
    expect(resolveApiUrl(env.ctx, cfg, 'https://flag.example.com')).toBe(
      'https://flag.example.com',
    );
  });

  it('masks secrets down to their prefix', () => {
    expect(maskSecret('sb_live_ab12CDefGhijKLmnOPqrSTuvWXyz0123456789')).toBe('sb_live_ab12…');
    expect(maskSecret('sb_live_ab12CDefGhij', 'sb_live_ab12')).toBe('sb_live_ab12…');
    expect(maskSecret('abcdefghijklmnop')).toBe('abcd…');
  });

  it('strips JSONC comments and trailing commas but not string contents', () => {
    const text = `{
      // line comment
      "url": "https://x.example.com/mcp", /* block */
      "note": "keep // this and /* this */ and ,}",
      "list": [1, 2,],
    }`;
    expect(JSON.parse(stripJsonc(text))).toEqual({
      url: 'https://x.example.com/mcp',
      note: 'keep // this and /* this */ and ,}',
      list: [1, 2],
    });
    expect(JSON.parse(stripJsonc('{"a":"esc \\" // still string"}'))).toEqual({
      a: 'esc " // still string',
    });
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    expect(relativeTime(null, now)).toBe('never');
    expect(relativeTime('2026-10-21T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-10-21T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-10-19T12:00:00Z', now)).toBe('2 d ago');
    expect(relativeTime('2026-01-01T00:00:00Z', now)).toBe('2026-01-01');
  });
});
