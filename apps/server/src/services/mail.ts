import type { Env } from '../env';

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
