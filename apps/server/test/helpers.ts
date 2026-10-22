import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../src/index';
import { createKey } from '../src/auth/keys';
import { upsertUserByEmail } from '../src/services/spaces';

export { env };

export async function call(
  input: string,
  init: RequestInit = {},
  envOverrides: Partial<typeof env> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://app.test${input}`, init),
    { ...env, ...envOverrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

let counter = 0;

/** A fresh user (allow-listed email aliases are fine because tests call helpers directly). */
export async function newUserWithKey(
  opts: { scopes?: ('read' | 'write')[]; project?: string } = {},
) {
  counter += 1;
  const user = await upsertUserByEmail(env.DB, `user${counter}-${crypto.randomUUID()}@example.com`);
  // Test users sign in as if by magic link, so their email counts as proven.
  await env.DB.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?')
    .bind(Date.now(), user.id)
    .run();
  const { key, secret } = await createKey(env.DB, env.KEY_PEPPER, {
    userId: user.id,
    label: 'test',
    client: 'test-client',
    machine: 'test-machine',
    scopes: opts.scopes ?? ['read', 'write'],
    project: opts.project ?? null,
  });
  return { user, key, secret };
}

let rpcId = 0;

/* eslint-disable @typescript-eslint/no-explicit-any -- tests assert on loosely-typed tool payloads */
export interface McpResult {
  isError: boolean;
  text: string;
  _meta: any;
  data: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Calls an MCP tool over Streamable HTTP and returns the parsed envelope (or the error text). */
export async function mcp(
  secret: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpResult> {
  rpcId += 1;
  const res = await call('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = (await res.json()) as {
    result?: { content: { text: string }[]; isError?: boolean };
    error?: { message: string };
  };
  if (body.error)
    return { isError: true, text: body.error.message, _meta: undefined, data: undefined };
  const text = body.result?.content[0]?.text ?? '';
  if (body.result?.isError) return { isError: true, text, _meta: undefined, data: undefined };
  const parsed = JSON.parse(text) as Pick<McpResult, '_meta' | 'data'>;
  return { isError: false, text, _meta: parsed._meta, data: parsed.data };
}
