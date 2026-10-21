/**
 * Secret redactor (LLD §4.4, FR-ACT-02). Runs in the CLI before anything is written to disk and
 * again in the server before anything is committed, so a leaky client cannot persist secrets.
 *
 * Matches are replaced with `[REDACTED:<kind>]`. The function is pure and idempotent: redacting
 * already-redacted text changes nothing.
 */

export interface RedactionFinding {
  kind: string;
  /** Offset in the original text. */
  index: number;
  length: number;
}

export interface RedactionResult {
  text: string;
  findings: RedactionFinding[];
}

interface Rule {
  kind: string;
  pattern: RegExp;
  /** Index of the capture group holding the secret; 0 means the whole match. */
  group?: number;
}

const RULES: Rule[] = [
  {
    kind: 'private-key',
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  {
    kind: 'aws-secret-key',
    pattern: /\baws[_-]?secret[_-]?access[_-]?key\b["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gi,
    group: 1,
  },
  {
    kind: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },
  { kind: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'stripe-key', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'slack-token', pattern: /\bxox[abposr]-[0-9A-Za-z-]{10,}/g },
  { kind: 'second-brain-key', pattern: /\bsb_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    kind: 'connection-string-password',
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^:\s/@]+:([^@\s]+)@/gi,
    group: 1,
  },
  {
    kind: 'bearer-token',
    pattern: /\bAuthorization\s*:\s*Bearer\s+([A-Za-z0-9._~+/-]{16,}=*)/gi,
    group: 1,
  },
  {
    kind: 'password',
    pattern:
      /\b(?:password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']?([^\s"',;]{6,})/gi,
    group: 1,
  },
];

const MARKER = /\[REDACTED:[a-z-]+\]/;

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Our own IDs (ULID-based, prefixed) are random but are not secrets. */
const SAFE_TOKEN = /^(?:prj|ses|top|spc|usr|key|org|grt|aud|evt|req)_[0-9A-Za-z]+$/;

function looksLikeHighEntropySecret(token: string): boolean {
  if (token.length < 32 || SAFE_TOKEN.test(token) || MARKER.test(token)) return false;
  if (/^[0-9a-f]+$/i.test(token)) return false; // hex digests and SHAs
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) return false;
  return shannonEntropy(token) >= 4.3;
}

export function redactSecrets(input: string, opts: { entropy?: boolean } = {}): RedactionResult {
  const useEntropy = opts.entropy ?? true;
  type Span = { start: number; end: number; kind: string };
  const spans: Span[] = [];

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const m of input.matchAll(rule.pattern)) {
      const whole = m[0];
      const start0 = m.index ?? 0;
      if (rule.group) {
        const secret = m[rule.group];
        if (!secret || MARKER.test(secret)) continue;
        const offset = whole.lastIndexOf(secret);
        spans.push({
          start: start0 + offset,
          end: start0 + offset + secret.length,
          kind: rule.kind,
        });
      } else {
        spans.push({ start: start0, end: start0 + whole.length, kind: rule.kind });
      }
    }
  }

  if (useEntropy) {
    for (const m of input.matchAll(/[A-Za-z0-9+/=_-]{32,}/g)) {
      const start = m.index ?? 0;
      if (looksLikeHighEntropySecret(m[0])) {
        spans.push({ start, end: start + m[0].length, kind: 'high-entropy' });
      }
    }
  }

  if (spans.length === 0) return { text: input, findings: [] };

  // Merge overlaps, keeping the earliest-starting (and then longest) span's kind.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ ...s });
    }
  }

  let out = '';
  let cursor = 0;
  const findings: RedactionFinding[] = [];
  for (const s of merged) {
    out += input.slice(cursor, s.start) + `[REDACTED:${s.kind}]`;
    findings.push({ kind: s.kind, index: s.start, length: s.end - s.start });
    cursor = s.end;
  }
  out += input.slice(cursor);
  return { text: out, findings };
}

/** Redacts every string inside a JSON-like value. Returns a new value; the input is not mutated. */
export function redactDeep<T>(
  value: T,
  opts: { entropy?: boolean } = {},
): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactSecrets(v, opts);
      count += r.findings.length;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)]));
    }
    return v;
  };
  return { value: walk(value) as T, count };
}
