import { type Env, isDev } from '../env';

/** Sends the magic-link email through Resend's HTTP API. The link is never logged. */
export async function sendMagicLink(env: Env, to: string, link: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to,
      subject: 'Sign in to Second Brain',
      text: `Sign in to Second Brain:\n\n${link}\n\nThis link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.`,
      html: `<p>Sign in to Second Brain:</p><p><a href="${link}">Sign in</a></p><p style="color:#6e6e73">This link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.</p>`,
    }),
  });
  if (!res.ok) throw new Error(`Email provider returned ${res.status}`);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Tells someone a space or project was shared with them. Nothing is shared until they accept in
 * the web app. Without an email provider (local dev) the invite is logged to the console instead;
 * it carries no secret, only a link to the Invitations page.
 */
export async function sendInvite(
  env: Env,
  to: string,
  invite: { from: string; spaceName: string; project: string | null; role: string; link: string },
): Promise<void> {
  const what = invite.project
    ? `the project "${invite.project}" in ${invite.spaceName}`
    : `the space ${invite.spaceName}`;
  const text = `${invite.from} shared ${what} with you on Second Brain as ${invite.role}.\n\nReview the invitation: ${invite.link}\n\nNothing reaches your notes or your assistants until you accept.`;
  if (!env.RESEND_API_KEY) {
    if (isDev(env)) console.warn(JSON.stringify({ level: 'info', mail: 'invite', to, text }));
    else
      console.warn(JSON.stringify({ level: 'warn', mail: 'invite', error: 'no email provider' }));
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to,
      subject: `${invite.from} shared ${invite.project ?? invite.spaceName} with you`,
      text,
      html: `<p>${escapeHtml(invite.from)} shared ${escapeHtml(what)} with you on Second Brain as <b>${escapeHtml(invite.role)}</b>.</p><p><a href="${escapeHtml(invite.link)}">Review the invitation</a></p><p style="color:#6e6e73">Nothing reaches your notes or your assistants until you accept.</p>`,
    }),
  });
  if (!res.ok) throw new Error(`Email provider returned ${res.status}`);
}
