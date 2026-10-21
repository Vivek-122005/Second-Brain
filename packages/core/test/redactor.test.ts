import { describe, expect, it } from 'vitest';
import { redactDeep, redactSecrets, shannonEntropy } from '../src/redactor';

// Fake credentials assembled at runtime so secret scanners don't flag this file.
const fake = (...parts: string[]) => parts.join('');

describe('redactSecrets', () => {
  const cases: [string, string, string][] = [
    ['aws-access-key', fake('AKIA', 'ABCDEFGHIJKLMNOP'), 'key=AKIA'],
    ['github-token', fake('ghp_', 'a'.repeat(36)), 'ghp_'],
    ['anthropic-key', fake('sk-ant-', 'api03-', 'x'.repeat(30)), 'sk-ant'],
    ['openai-key', fake('sk-proj-', 'Ab1'.repeat(10)), 'sk-proj'],
    ['stripe-key', fake('sk_live_', '4eC39HqLyjWDarjtT1zdp7dc'), 'sk_live'],
    ['google-api-key', fake('AIza', 'SyA-', 'b'.repeat(31)), 'AIza'],
    ['slack-token', fake('xoxb-', '1234567890-abcdefghij'), 'xoxb'],
    ['second-brain-key', fake('sb_live_', 'Zx9'.repeat(8)), 'sb_live'],
    [
      'jwt',
      fake(
        'eyJhbGciOiJIUzI1NiJ9',
        '.',
        'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
        '.',
        'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      ),
      'eyJ',
    ],
  ];

  it.each(cases)('redacts %s', (kind, secret, leak) => {
    const r = redactSecrets(`token: ${secret} end`);
    expect(r.text).toContain(`[REDACTED:`);
    expect(r.text).not.toContain(secret);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.map((f) => f.kind)).toContain(
      kind === 'aws-access-key' ? 'aws-access-key' : kind,
    );
    expect(leak).toBeTruthy();
  });

  it('redacts private key blocks entirely', () => {
    const kind = fake('RSA PRIV', 'ATE KEY');
    const pem = `-----BEGIN ${kind}-----\nMIIEow\nabc\n-----END ${kind}-----`;
    expect(redactSecrets(`before\n${pem}\nafter`).text).toBe(
      'before\n[REDACTED:private-key]\nafter',
    );
  });

  it('redacts only the value of password-style assignments', () => {
    expect(redactSecrets('DB_PASSWORD=hunter2hunter').text).toBe('DB_PASSWORD=hunter2hunter');
    expect(redactSecrets('password: "hunter2hunter"').text).toBe('password: "[REDACTED:password]"');
    expect(redactSecrets('api_key=abcdef123456').text).toBe('api_key=[REDACTED:password]');
  });

  it('redacts credentials in connection strings', () => {
    expect(redactSecrets('postgres://app:s3cr3tPass@db:5432/x').text).toBe(
      'postgres://app:[REDACTED:connection-string-password]@db:5432/x',
    );
  });

  it('redacts bearer tokens in headers', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop1234').text).toBe(
      'Authorization: Bearer [REDACTED:bearer-token]',
    );
  });

  it('catches random high-entropy tokens but not hashes, ids or prose', () => {
    const random = fake('q8Zr2LmX7vNp4TcW', 'e9KbH3yJ6sDf1GaU');
    expect(redactSecrets(`value ${random}`).text).toBe('value [REDACTED:high-entropy]');
    const sha = 'a3f5c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2';
    const id = 'ses_01JB3XK2Y9ZQ8W7V6T5S4R3P2N';
    const text = `commit ${sha} session ${id} and a perfectly ordinary sentence here`;
    expect(redactSecrets(text).text).toBe(text);
  });

  it('is idempotent', () => {
    const once = redactSecrets(`k=${fake('ghp_', 'b'.repeat(36))} password=supersecret1`).text;
    expect(redactSecrets(once).text).toBe(once);
  });

  it('leaves clean text untouched', () => {
    const text = 'We chose Postgres advisory locks because Redis adds an ops dependency.';
    expect(redactSecrets(text)).toEqual({ text, findings: [] });
  });
});

describe('redactDeep', () => {
  it('redacts strings anywhere in a JSON value without mutating it', () => {
    const input = { a: [`x ${fake('ghp_', 'c'.repeat(36))}`], b: { c: 1, d: 'ok' } };
    const { value, count } = redactDeep(input);
    expect(count).toBe(1);
    expect(value.a[0]).toBe('x [REDACTED:github-token]');
    expect(input.a[0]).toContain('ghp_');
    expect(value.b).toEqual({ c: 1, d: 'ok' });
  });
});

describe('shannonEntropy', () => {
  it('is 0 for empty or uniform strings and grows with variety', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
  });
});
