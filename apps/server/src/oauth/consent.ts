import type { KeyScope } from '@second-brain/schema';
import { hmacHex, timingSafeEqual } from '../lib/crypto';
import type { SpaceRow } from '../services/spaces';

/**
 * The server-rendered consent page (no JavaScript, no external assets). Every value from the
 * request or the client's registration is HTML-escaped.
 */

const CSRF_TTL_MS = 15 * 60_000;

/** A CSRF token bound to the browser session: `<issued-at>.<HMAC(pepper, session hash, issued-at)>`. */
export async function csrfToken(
  pepper: string,
  sessionHash: string,
  now = Date.now(),
): Promise<string> {
  return `${now}.${await hmacHex(pepper, `oauth-consent|${sessionHash}|${now}`)}`;
}

export async function verifyCsrf(
  pepper: string,
  sessionHash: string,
  token: string,
): Promise<boolean> {
  const [ts, mac] = token.split('.');
  const issued = Number(ts);
  if (!mac || !Number.isSafeInteger(issued)) return false;
  const age = Date.now() - issued;
  if (age < 0 || age > CSRF_TTL_MS) return false;
  return timingSafeEqual(mac, await hmacHex(pepper, `oauth-consent|${sessionHash}|${issued}`));
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Security headers for every page we render. Styles are inline; nothing else may load. */
export const PAGE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f5f5f7; --card: #ffffff; --text: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7;
  --accent: #0071e3; --accent-text: #ffffff; --soft: #f5f5f7; --warn: #b25000;
  --shadow: 0 1px 2px rgba(0,0,0,.04), 0 12px 40px rgba(0,0,0,.08);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #000000; --card: #1c1c1e; --text: #f5f5f7; --muted: #a1a1a6; --line: #38383a;
    --accent: #0a84ff; --soft: #2c2c2e; --warn: #ff9f0a; --shadow: none;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px;
  background: var(--bg); color: var(--text);
  font: 15px/1.47 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { width: 100%; max-width: 420px; background: var(--card); border-radius: 18px; padding: 32px 28px 28px; box-shadow: var(--shadow); }
.mark { width: 44px; height: 44px; border-radius: 12px; background: var(--accent); color: var(--accent-text);
  display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 18px; margin: 0 auto 18px; }
h1 { font-size: 21px; line-height: 1.25; font-weight: 600; letter-spacing: -.01em; text-align: center; margin: 0 0 6px; }
.sub { color: var(--muted); text-align: center; margin: 0 0 24px; font-size: 14px; word-break: break-word; }
.section { border-top: 1px solid var(--line); padding: 16px 0; }
.label { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 8px; }
.row { display: flex; gap: 12px; align-items: flex-start; padding: 6px 0; }
.row input { margin: 3px 0 0; width: 18px; height: 18px; accent-color: var(--accent); flex: none; }
.row strong { display: block; font-weight: 500; }
.row span { color: var(--muted); font-size: 13px; }
.host { font-weight: 500; word-break: break-all; }
.note { color: var(--muted); font-size: 13px; margin: 6px 0 0; }
.note.warn { color: var(--warn); }
select { width: 100%; font: inherit; color: var(--text); background: var(--soft); border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; }
.buttons { display: flex; gap: 12px; margin-top: 20px; }
button { flex: 1; font: inherit; font-weight: 500; border-radius: 980px; padding: 11px 16px; cursor: pointer; border: 0; }
button.primary { background: var(--accent); color: var(--accent-text); }
button.secondary { background: var(--soft); color: var(--text); }
button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 2px; }
.foot { color: var(--muted); font-size: 12px; text-align: center; margin: 18px 0 0; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLES}</style></head>
<body><main>${body}</main></body></html>`;
}

export function errorPage(title: string, message: string): string {
  return page(
    title,
    `<div class="mark">!</div><h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(message)}</p>
<p class="foot">Go back to your app and try connecting again.</p>`,
  );
}

export interface ConsentView {
  clientName: string;
  redirectUri: URL;
  loopback: boolean;
  email: string;
  scopes: KeyScope[];
  spaces: SpaceRow[];
  /** Hidden fields carried to the POST: the validated authorization request plus the CSRF token. */
  hidden: Record<string, string>;
}

function redirectLabel(u: URL): string {
  return u.host || `${u.protocol}//`;
}

export function consentPage(v: ConsentView): string {
  const hidden = Object.entries(v.hidden)
    .map(([k, val]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(val)}">`)
    .join('');
  const write = v.scopes.includes('write');
  const space =
    v.spaces.length === 1
      ? `<p class="host">${escapeHtml(v.spaces[0]?.name ?? '')}</p>`
      : `<select name="space_id" aria-label="Space">${v.spaces
          .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
          .join('')}</select>`;
  const spaceField =
    v.spaces.length === 1
      ? `<input type="hidden" name="space_id" value="${escapeHtml(v.spaces[0]?.id ?? '')}">`
      : '';

  return page(
    `Connect ${v.clientName}`,
    `<div class="mark" aria-hidden="true">SB</div>
<h1>${escapeHtml(v.clientName)} wants to use your Second Brain</h1>
<p class="sub">Signed in as ${escapeHtml(v.email)}</p>
<form method="post" action="/oauth/authorize">${hidden}${spaceField}
  <div class="section">
    <p class="label">It will be able to</p>
    <label class="row"><input type="checkbox" checked disabled><span><strong>Read</strong><span>Search and read your notes, projects and decisions.</span></span></label>
    ${
      write
        ? `<label class="row"><input type="checkbox" name="scope_write" value="1" checked><span><strong>Write</strong><span>Save sessions, record decisions and edit notes.</span></span></label>`
        : ''
    }
  </div>
  <div class="section">
    <p class="label">Space</p>
    ${space}
  </div>
  <div class="section">
    <p class="label">After you choose, you return to</p>
    <p class="host">${escapeHtml(redirectLabel(v.redirectUri))}</p>
    ${
      v.loopback
        ? '<p class="note">An app running on this computer.</p>'
        : '<p class="note">Apps choose their own names. Only allow this if you just started connecting it.</p>'
    }
  </div>
  <div class="buttons">
    <button class="secondary" type="submit" name="decision" value="deny">Deny</button>
    <button class="primary" type="submit" name="decision" value="approve">Allow</button>
  </div>
</form>
<p class="foot">You can disconnect it at any time in Settings → Connected apps.</p>`,
  );
}
