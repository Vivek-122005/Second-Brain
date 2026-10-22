import {
  AcceptGrantRequest,
  CreateGrantRequest,
  ListGrantsQuery,
  ListInvitationsQuery,
  UpdateGrantRequest,
} from '@second-brain/schema';
import { Hono } from 'hono';
import { type AppEnv, requirePrincipal } from '../auth/principal';
import { parse, readJson } from '../lib/http';
import {
  createGrant,
  listGrants,
  listInvitations,
  respondToGrant,
  revokeGrant,
  updateGrant,
} from '../services/grants';

/** Sharing (FR-SHR-02..04). Authorization lives in `authz` and `services/grants`. */
export const grantRoutes = new Hono<AppEnv>();

grantRoutes.post('/grants', async (c) => {
  const p = requirePrincipal(c);
  const input = parse(CreateGrantRequest, await readJson(c));
  return c.json(await createGrant(c.env, p, input, new URL(c.req.url).origin), 201);
});

grantRoutes.get('/grants', async (c) => {
  const p = requirePrincipal(c);
  const q = parse(ListGrantsQuery, c.req.query());
  return c.json({ items: await listGrants(c.env, p, q.space_id), next_cursor: null });
});

grantRoutes.get('/invitations', async (c) => {
  const p = requirePrincipal(c);
  const q = parse(ListInvitationsQuery, c.req.query());
  return c.json({ items: await listInvitations(c.env, p, q.status), next_cursor: null });
});

grantRoutes.post('/grants/:id/accept', async (c) => {
  const p = requirePrincipal(c);
  const input = parse(AcceptGrantRequest, await readJson(c));
  return c.json(
    await respondToGrant(c.env, p, c.req.param('id'), 'accept', input.include_in_agent_context),
  );
});

grantRoutes.post('/grants/:id/decline', async (c) => {
  const p = requirePrincipal(c);
  return c.json(await respondToGrant(c.env, p, c.req.param('id'), 'decline', false));
});

grantRoutes.patch('/grants/:id', async (c) => {
  const p = requirePrincipal(c);
  const input = parse(UpdateGrantRequest, await readJson(c));
  return c.json(await updateGrant(c.env, p, c.req.param('id'), input));
});

grantRoutes.delete('/grants/:id', async (c) => {
  const p = requirePrincipal(c);
  await revokeGrant(c.env, p, c.req.param('id'));
  return c.body(null, 204);
});
