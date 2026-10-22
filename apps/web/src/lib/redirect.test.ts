import { describe, expect, it } from 'vitest';
import { resolveDestination, safeRedirect } from './redirect';

const ORIGIN = 'https://brain.example.com';

describe('resolveDestination', () => {
  it('keeps same-app relative paths', () => {
    expect(resolveDestination('/topics?path=a.md#x', ORIGIN)).toEqual({
      href: '/topics?path=a.md#x',
      server: false,
    });
  });

  it('accepts absolute URLs on this origin and marks server-rendered pages', () => {
    const next = `${ORIGIN}/oauth/authorize?client_id=c&redirect_uri=${encodeURIComponent('https://client.example/cb')}`;
    expect(resolveDestination(next, ORIGIN)).toEqual({
      href: `/oauth/authorize?client_id=c&redirect_uri=${encodeURIComponent('https://client.example/cb')}`,
      server: true,
    });
    expect(resolveDestination('/api/v1/me', ORIGIN).server).toBe(true);
  });

  it.each([
    'https://evil.example/oauth/authorize',
    'http://brain.example.com/', // different scheme = different origin
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'data:text/html,hi',
    'not a url',
    '',
    undefined,
  ])('falls back to / for %j', (value) => {
    expect(resolveDestination(value, ORIGIN)).toEqual({ href: '/', server: false });
  });

  it('keeps safeRedirect behaviour for relative paths', () => {
    expect(safeRedirect('/keys')).toBe('/keys');
    expect(safeRedirect('//evil')).toBe('/');
  });
});
