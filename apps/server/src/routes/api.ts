import {
  graph,
  listNotes,
  listProjects,
  noteStats,
  recentDecisions,
  recentSessionNotes,
  safeJson,
  searchNotes,
} from '@second-brain/db';
import {
  type ConnectInfo,
  CreateKeyRequest,
  type DashboardResponse,
  ImportRequest,
  ListNotesQuery,
  ListProjectsQuery,
  type MeResponse,
  NoteType,
  type Page,
  type NoteSummary,
  SaveNoteRequest,
} from '@second-brain/schema';
import { Hono } from 'hono';
import { z } from 'zod';
import { createKey, listKeys, revokeKey } from '../auth/keys';
import {
  type AppEnv,
  checkProject,
  requirePrincipal,
  requireScope,
  spaceFor,
} from '../auth/principal';
import { effectiveRole, readScope, withSource } from '../authz';
import { HttpError, notFound, parse, readJson } from '../lib/http';
import { audit } from '../services/audit';
import { check } from '../services/memory';
import { importFiles, noteDetail, writeNote } from '../services/notes';
import { toSpaceSummary } from '../services/spaces';

export const apiRoutes = new Hono<AppEnv>();

apiRoutes.get('/me', (c) => {
  const p = requirePrincipal(c);
  const body: MeResponse = {
    user: { id: p.userId, email: p.email, name: p.name },
    spaces: p.spaces.map((s) => toSpaceSummary(s, p.userId)),
    default_space_id: p.defaultSpace.id,
  };
  return c.json(body);
});

apiRoutes.get('/connect', (c) => {
  requirePrincipal(c);
  const origin = new URL(c.req.url).origin;
  const body: ConnectInfo = { mcp_url: `${origin}/mcp`, api_url: origin };
  return c.json(body);
});

// ── Keys (FR-IAM-02/03, FR-WEB-04) ─────────────────────────────────────────
apiRoutes.get('/keys', async (c) => {
  const p = requirePrincipal(c);
  const items = await listKeys(c.env.DB, p.userId);
  return c.json({ items, next_cursor: null });
});

apiRoutes.post('/keys', async (c) => {
  const p = requirePrincipal(c);
  requireScope(p, 'write');
  const input = parse(CreateKeyRequest, await readJson(c));
  // A key can never grant more than the key that creates it.
  if (p.via === 'key' && input.scopes.some((s) => !p.scopes.includes(s))) {
    throw new HttpError(
      403,
      'Forbidden',
      'A key cannot create a key with more scopes than it has.',
    );
  }
  checkProject(p, input.project);
  const { key, secret } = await createKey(c.env.DB, c.env.KEY_PEPPER, {
    userId: p.userId,
    label: input.label,
    machine: input.machine,
    client: input.client,
    scopes: input.scopes,
    project: input.project ?? p.project,
    expiresInDays: input.expires_in_days,
  });
  await audit(c.env.DB, {
    spaceId: null,
    actorUserId: p.userId,
    actorKeyId: p.keyId,
    action: 'key.create',
    target: key.id,
  });
  return c.json({ key, secret }, 201);
});

apiRoutes.delete('/keys/:id', async (c) => {
  const p = requirePrincipal(c);
  const ok = await revokeKey(c.env.DB, p.userId, c.req.param('id'));
  if (!ok) throw notFound('No active key with that id.');
  await audit(c.env.DB, {
    spaceId: null,
    actorUserId: p.userId,
    actorKeyId: p.keyId,
    action: 'key.revoke',
    target: c.req.param('id'),
  });
  return c.body(null, 204);
});

// ── Notes ──────────────────────────────────────────────────────────────────
apiRoutes.get('/notes', async (c) => {
  const p = requirePrincipal(c);
  const q = parse(ListNotesQuery, c.req.query());
  checkProject(p, q.project);
  const page = await listNotes(c.env.DB, {
    spaceIds: readScope(p, q.space_id ? { spaceId: spaceFor(p, q.space_id).id } : {}),
    type: q.type,
    project: q.project ?? p.project ?? undefined,
    cursor: q.cursor,
    limit: q.limit,
  });
  const body: Page<NoteSummary> = {
    items: page.items.map((n) =>
      withSource(p, n.space_id, {
        path: n.path,
        title: n.title,
        type: n.type,
        project: n.project_slug,
        tags: JSON.parse(n.tags) as string[],
        updated_at: new Date(n.updated_at).toISOString(),
      }),
    ),
    next_cursor: page.next,
  };
  return c.json(body);
});

apiRoutes.get('/note', async (c) => {
  const p = requirePrincipal(c);
  const path = c.req.query('path');
  if (!path) throw new HttpError(400, 'Bad request', 'path is required.');
  return c.json(await noteDetail(c.env, p, path, c.req.query('space_id') || undefined));
});

apiRoutes.put('/note', async (c) => {
  const p = requirePrincipal(c);
  const input = parse(SaveNoteRequest, await readJson(c));
  const r = await writeNote(c.env, p, spaceFor(p, input.space_id), {
    path: input.path,
    content: input.content,
    baseVersion: input.base_version,
    message: input.message,
  });
  return c.json(r);
});

// ── Search, projects, dashboard, graph ─────────────────────────────────────
const SearchQuery = z.object({
  q: z.string().min(1).max(500),
  types: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(z.array(NoteType).optional()),
  project: z.string().optional(),
  space_id: z.string().min(1).max(64).optional(),
  include_sessions: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

apiRoutes.get('/search', async (c) => {
  const p = requirePrincipal(c);
  const q = parse(SearchQuery, c.req.query());
  checkProject(p, q.project);
  const hits = await searchNotes(c.env.DB, {
    spaceIds: readScope(p, q.space_id ? { spaceId: spaceFor(p, q.space_id).id } : {}),
    query: q.q,
    types: q.types,
    project: q.project ?? p.project ?? undefined,
    includeSessions: q.include_sessions === 'true',
    limit: q.limit,
  });
  return c.json({
    hits: hits.map(({ space_id, ...h }) => withSource(p, space_id, h)),
    mode: 'keyword',
  });
});

apiRoutes.get('/projects', async (c) => {
  const p = requirePrincipal(c);
  const q = parse(ListProjectsQuery, c.req.query());
  const items = await listProjects(c.env.DB, readScope(p), q.status);
  return c.json({ items: items.map(({ space_id, ...x }) => withSource(p, space_id, x)) });
});

const EMPTY_CHECK = {
  unsaved_sessions: [],
  stale_projects: [],
  broken_links: [],
  duplicate_topics: [],
  suspicious_notes: [],
  suggestions: [],
};

/** One space at a time (`?space_id=`, default: your default space), so paths stay unambiguous. */
apiRoutes.get('/dashboard', async (c) => {
  const p = requirePrincipal(c);
  const space = spaceFor(p, c.req.query('space_id'));
  const spaceIds = readScope(p, { spaceId: space.id });
  const [projects, sessions, decisions, findings, stats] = await Promise.all([
    listProjects(c.env.DB, spaceIds, 'active'),
    recentSessionNotes(c.env.DB, spaceIds, { limit: 8 }),
    recentDecisions(c.env.DB, spaceIds, { limit: 8 }),
    // Hygiene findings cover the whole space, so they need a space-wide role.
    effectiveRole(p, space.id) ? check(c.env, space, { stale_days: 14 }) : EMPTY_CHECK,
    noteStats(c.env.DB, spaceIds),
  ]);
  const body: DashboardResponse = {
    projects: projects.map(({ space_id: _s, ...x }) => x),
    recent_sessions: sessions.map((s) => {
      const fm = safeJson(s.frontmatter);
      const project =
        typeof fm.project === 'string'
          ? (/\[\[(?:projects\/)?([^\]|#]+)/.exec(fm.project)?.[1] ?? null)
          : null;
      return {
        id: typeof fm.id === 'string' ? fm.id : s.path,
        date: typeof fm.saved === 'string' ? fm.saved : new Date(s.updated_at).toISOString(),
        summary: typeof fm.summary === 'string' ? fm.summary : '',
        project,
        path: s.path,
      };
    }),
    recent_decisions: decisions.map((d) => ({
      id: d.id,
      title: d.title,
      date: d.date,
      project: d.project_slug,
      path: d.path,
    })),
    check: findings,
    stats,
  };
  return c.json(body);
});

apiRoutes.get('/graph', async (c) => {
  const p = requirePrincipal(c);
  const space = spaceFor(p, c.req.query('space_id'));
  return c.json(await graph(c.env.DB, readScope(p, { spaceId: space.id })));
});

// ── Import (bring an existing Markdown vault in as one commit) ─────────────
apiRoutes.post('/import', async (c) => {
  const p = requirePrincipal(c);
  if (p.project) throw new HttpError(403, 'Forbidden', 'Project-limited keys cannot import.');
  const input = parse(ImportRequest, await readJson(c));
  const r = await importFiles(c.env, p, spaceFor(p, input.space_id), input.files, input.message);
  return c.json(r);
});
