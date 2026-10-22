/**
 * In-memory implementation of the REST contract, used when `VITE_MOCK_API=true` and in tests.
 *
 * It is a fake `fetch`: the real HTTP client (URL building, problem+json parsing) runs unchanged
 * on top of it, so mock mode exercises the same code paths as production. Note parsing, link
 * resolution, decision logs and hygiene checks reuse `@second-brain/core`, so behaviour matches
 * what the server will do.
 *
 * Never logs note content or secrets.
 */
import {
  chunkNote,
  extractWikilinks,
  findDuplicateTopics,
  findSuspiciousInstructions,
  InvalidPathError,
  normalizeVaultPath,
  noteTitle,
  parseDecisionLog,
  parseNote,
  projectSlugFromPath,
  resolveLink,
  typeFromPath,
} from '@second-brain/core';
import { createHttpClient, type ApiClient } from './client';
import type {
  ApiKey,
  CheckOutput,
  ConnectGitHubVaultInput,
  ConnectGitHubVaultResponse,
  ConnectInfo,
  CreateKeyInput,
  CreateKeyResponse,
  DashboardResponse,
  DeviceApproveInput,
  DeviceRequestInfo,
  DisconnectGitHubVaultResponse,
  KeyScope,
  MagicLinkResponse,
  MeResponse,
  NoteDetail,
  NoteSummary,
  NoteType,
  OAuthGrant,
  Page,
  ProblemDetails,
  ProjectSummary,
  SaveNoteRequest,
  SaveNoteResponse,
  SearchHit,
  SearchResponse,
  VaultStatus,
} from './contract';
import type {
  AuthProviders,
  PasskeyLoginOptionsResponse,
  PasskeyRegisterOptionsResponse,
  Passkey,
} from './auth-contract';
import { buildVault, FIXTURE_DEVICE_CODE, FIXTURE_KEYS } from './fixtures';

const NOTE_TYPES: NoteType[] = ['project', 'decision-log', 'topic', 'session', 'note'];
const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'];
const STALE_DAYS = 14;
const SIGNED_IN_KEY = 'sb.mock.signedIn';

interface StoredNote {
  raw: string;
  version: string;
  updatedAt: string;
}

interface DeviceRequest {
  info: DeviceRequestInfo;
  status: 'pending' | 'approved' | 'denied';
}

export interface MockServerOptions {
  /** Artificial latency per request in ms (default 0). */
  latencyMs?: number;
  /** Clock, for deterministic tests. */
  now?: () => Date;
  /** Start signed in (default true). */
  signedIn?: boolean;
  /** Persist the signed-in flag in sessionStorage so a reload keeps you signed in. */
  persistSession?: boolean;
  /** Whether email links are offered (default true). Off, the last passkey cannot be removed. */
  magicLink?: boolean;
  /** Whether the server has VAULT_KEK set (default true). Off, connecting GitHub answers 503. */
  vaultKek?: boolean;
}

/** A space's vault in the mock. The token stays here and is never returned, like the server. */
interface MockVault {
  status: VaultStatus;
  token: string | null;
}

class HttpProblem extends Error {
  constructor(readonly problem: ProblemDetails & Record<string, unknown>) {
    super(problem.title);
  }
}

function problem(status: number, title: string, detail?: string): HttpProblem {
  return new HttpProblem({
    type: `https://second-brain.dev/problems/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    ...(detail ? { detail } : {}),
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function randomBase62(length: number): string {
  const a = new Uint8Array(length);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => BASE62[b % 62]).join('');
}

function randomBase64Url(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v instanceof Date) return v.toISOString();
  return null;
}

function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter((x): x is string => x !== null);
  const s = asString(v);
  return s ? [s] : [];
}

/** `"[[projects/billing]]"`, `projects/billing` or `billing` → `billing`. */
function projectSlugFromValue(v: unknown): string | null {
  const s = asString(v);
  if (!s) return null;
  const inner = s.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0] ?? '';
  const last = inner.split('/').pop() ?? inner;
  return last.replace(/\.md$/i, '') || null;
}

function readSessionFlag(): boolean | null {
  try {
    const v = globalThis.sessionStorage?.getItem(SIGNED_IN_KEY);
    return v === null || v === undefined ? null : v === '1';
  } catch {
    return null;
  }
}

function writeSessionFlag(signedIn: boolean): void {
  try {
    globalThis.sessionStorage?.setItem(SIGNED_IN_KEY, signedIn ? '1' : '0');
  } catch {
    // Storage unavailable; the flag just won't survive a reload.
  }
}

export class MockServer {
  private notes = new Map<string, StoredNote>();
  private keys: ApiKey[] = [];
  private devices = new Map<string, DeviceRequest>();
  private magicTokens = new Set<string>();
  /** Passkeys registered in this mock session (signatures are not verified). */
  private passkeys: Passkey[] = [];
  private readonly magicLink: boolean;
  private readonly vaultKek: boolean;
  private vaults = new Map<string, MockVault>();
  private oauthGrants: OAuthGrant[] = [];
  private registerChallenge: string | null = null;
  private loginChallenge: string | null = null;
  private versionCounter = 0;
  private signedIn: boolean;
  private readonly latencyMs: number;
  private readonly now: () => Date;
  private readonly persistSession: boolean;

  constructor(opts: MockServerOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 0;
    this.now = opts.now ?? (() => new Date());
    this.persistSession = opts.persistSession ?? false;
    const persisted = this.persistSession ? readSessionFlag() : null;
    this.signedIn = persisted ?? opts.signedIn ?? true;
    this.magicLink = opts.magicLink ?? true;
    this.vaultKek = opts.vaultKek ?? true;
    this.passkeys.push({
      id: 'pk_seed_macbook',
      name: 'MacBook Pro',
      created_at: new Date(this.now().getTime() - 9 * 86_400_000).toISOString(),
      last_used_at: new Date(this.now().getTime() - 3_600_000).toISOString(),
      transports: ['internal', 'hybrid'],
    });
    this.oauthGrants.push({
      id: 'oag_seed_claude',
      client_id: 'mcp_client_claude',
      client_name: 'Claude',
      client_uri: 'https://claude.ai',
      redirect_hosts: ['claude.ai'],
      scopes: ['read', 'write'],
      space_id: 'spc_personal',
      created_at: new Date(this.now().getTime() - 6 * 86_400_000).toISOString(),
      last_used_at: new Date(this.now().getTime() - 2 * 3_600_000).toISOString(),
    });
    this.seed();
  }

  private seed(): void {
    const now = this.now();
    for (const f of buildVault(now)) {
      this.notes.set(f.path, {
        raw: f.raw,
        version: this.nextVersion(),
        updatedAt: new Date(now.getTime() - f.ageDays * 86_400_000 - 3_600_000).toISOString(),
      });
    }
    this.keys = FIXTURE_KEYS.map((k) => ({
      id: k.id,
      label: k.label,
      machine: k.machine,
      client: k.client,
      prefix: k.prefix,
      scopes: k.scopes,
      space_id: 'spc_personal',
      project: k.project,
      created_at: new Date(now.getTime() - k.createdDaysAgo * 86_400_000).toISOString(),
      last_used_at:
        k.lastUsedDaysAgo === null
          ? null
          : new Date(now.getTime() - k.lastUsedDaysAgo * 86_400_000 - 1_800_000).toISOString(),
      expires_at: null,
      revoked_at: null,
    }));
    this.devices.set(FIXTURE_DEVICE_CODE, {
      status: 'pending',
      info: {
        user_code: FIXTURE_DEVICE_CODE,
        client: 'brain-cli',
        machine: 'mac-mini',
        created_at: new Date(now.getTime() - 60_000).toISOString(),
        expires_at: new Date(now.getTime() + 14 * 60_000).toISOString(),
      },
    });
  }

  private nextVersion(): string {
    this.versionCounter += 1;
    return `v${this.versionCounter.toString(36)}-${randomHex(4)}`;
  }

  private setSignedIn(v: boolean): void {
    this.signedIn = v;
    if (this.persistSession) writeSessionFlag(v);
  }

  // ── Derived views ─────────────────────────────────────────────────────────

  private summary(path: string, note: StoredNote): NoteSummary {
    const parsed = parseNote(note.raw);
    const fm = parsed.frontmatter;
    const fmType = asString(fm.type);
    const type: NoteType =
      fmType && (NOTE_TYPES as string[]).includes(fmType)
        ? (fmType as NoteType)
        : typeFromPath(path);
    const project =
      type === 'project'
        ? (projectSlugFromPath(path) ?? null)
        : (projectSlugFromValue(fm.project) ?? projectSlugFromPath(path) ?? null);
    return {
      path,
      title: noteTitle(path, fm, parsed.body),
      type,
      project,
      tags: asStringList(fm.tags),
      updated_at: note.updatedAt,
    };
  }

  private allSummaries(): NoteSummary[] {
    return [...this.notes.entries()]
      .map(([p, n]) => this.summary(p, n))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.path.localeCompare(b.path));
  }

  /** Resolves a wikilink target by path, basename, title or alias. */
  private resolve(target: string): string | null {
    const direct = resolveLink(target, this.notes.keys());
    if (direct) return direct;
    const wanted = target.trim().toLowerCase();
    for (const [path, note] of this.notes) {
      const { frontmatter, body } = parseNote(note.raw);
      if (noteTitle(path, frontmatter, body).toLowerCase() === wanted) return path;
      if (asStringList(frontmatter.aliases).some((a) => a.toLowerCase() === wanted)) return path;
    }
    return null;
  }

  private detail(path: string): NoteDetail {
    const note = this.notes.get(path);
    if (!note) throw problem(404, 'Not found', `No note at ${path}.`);
    const parsed = parseNote(note.raw);
    const seen = new Set<string>();
    const links: NoteDetail['links'] = [];
    for (const l of extractWikilinks(parsed.body)) {
      if (seen.has(l.target)) continue;
      seen.add(l.target);
      links.push({ target: l.target, path: this.resolve(l.target) });
    }
    const backlinks: NoteDetail['backlinks'] = [];
    for (const [otherPath, other] of this.notes) {
      if (otherPath === path) continue;
      const otherParsed = parseNote(other.raw);
      const targets = extractWikilinks(otherParsed.body).map((l) => l.target);
      const fmProject = asString(otherParsed.frontmatter.project);
      if (fmProject?.startsWith('[[')) targets.push(fmProject.slice(2, -2));
      if (targets.some((t) => this.resolve(t) === path)) {
        backlinks.push({
          path: otherPath,
          title: noteTitle(otherPath, otherParsed.frontmatter, otherParsed.body),
        });
      }
    }
    return {
      ...this.summary(path, note),
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      raw: note.raw,
      version: note.version,
      links,
      backlinks,
    };
  }

  private projectSummaries(): ProjectSummary[] {
    const out: ProjectSummary[] = [];
    for (const [path, note] of this.notes) {
      if (!path.startsWith('projects/')) continue;
      const { frontmatter, body } = parseNote(note.raw);
      if (asString(frontmatter.type) && frontmatter.type !== 'project') continue;
      const next = asStringList(frontmatter.next)[0];
      const updated = asString(frontmatter.updated) ?? note.updatedAt.slice(0, 10);
      out.push({
        slug: projectSlugFromPath(path) ?? path,
        title: noteTitle(path, frontmatter, body),
        status: asString(frontmatter.status) ?? 'active',
        ...(next ? { next } : {}),
        updated,
      });
    }
    return out.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  }

  private check(): CheckOutput {
    const now = this.now().getTime();
    const stale = this.projectSummaries()
      .filter((p) => p.status === 'active' && p.updated)
      .filter((p) => now - new Date(p.updated ?? 0).getTime() > STALE_DAYS * 86_400_000)
      .map((p) => ({ slug: p.slug, title: p.title, ...(p.updated ? { updated: p.updated } : {}) }));

    const broken: CheckOutput['broken_links'] = [];
    const suspicious: CheckOutput['suspicious_notes'] = [];
    const topics: { path: string; title: string; aliases: string[] }[] = [];
    for (const [path, note] of this.notes) {
      const { frontmatter, body } = parseNote(note.raw);
      for (const l of extractWikilinks(body)) {
        if (!this.resolve(l.target)) broken.push({ from: path, target: l.target });
      }
      for (const reason of findSuspiciousInstructions(body)) suspicious.push({ path, reason });
      if (path.startsWith('topics/')) {
        topics.push({
          path,
          title: noteTitle(path, frontmatter, body),
          aliases: asStringList(frontmatter.aliases),
        });
      }
    }
    const duplicates = findDuplicateTopics(topics);
    const unsaved = [
      {
        id: 'ses_01JB8A0000000000000000000H',
        project: 'mobile-offline-sync',
        opened_at: new Date(now - 2 * 86_400_000).toISOString(),
      },
    ];

    const suggestions: string[] = [];
    if (stale.length)
      suggestions.push(`Review ${stale.length} stale active project(s) or pause them.`);
    if (broken.length) suggestions.push(`Create or fix ${broken.length} broken link(s).`);
    if (duplicates.length) suggestions.push('Merge duplicate topics so search stays sharp.');
    if (unsaved.length)
      suggestions.push('Save or discard sessions that were opened but never saved.');
    return {
      unsaved_sessions: unsaved,
      stale_projects: stale,
      broken_links: broken,
      duplicate_topics: duplicates,
      suspicious_notes: suspicious,
      suggestions,
    };
  }

  // ── Endpoints ─────────────────────────────────────────────────────────────

  private requireAuth(): void {
    if (!this.signedIn) throw problem(401, 'Not signed in', 'Sign in to continue.');
  }

  // ── Vault (GitHub sync) ───────────────────────────────────────────────────
  //
  // Conventions so every server answer can be tried by hand:
  //   repo owner "missing"       → 400 Repository not found
  //   token containing "revoked" → 400 GitHub rejected the token
  //   token containing "readonly"→ 400 The token lacks permission
  //   repo name containing "existing" has 12 notes (push_managed needs confirm_overwrite)
  //   token containing "nohooks" → the webhook can't be created; its secret is shown instead

  private vault(spaceId: string): MockVault {
    let v = this.vaults.get(spaceId);
    if (!v) {
      const github = spaceId === 'spc_acme';
      v = {
        token: github ? 'github_pat_seed' : null,
        status: {
          space_id: spaceId,
          provider: github ? 'github' : 'managed',
          repo: github ? 'acme/platform-brain' : null,
          branch: github ? 'main' : null,
          last_synced_sha: github ? 'a1b2c3d4e5f6' : null,
          last_synced_at: github
            ? new Date(this.now().getTime() - 20 * 60_000).toISOString()
            : null,
          last_sync_error: null,
          webhook: github
            ? {
                configured: true,
                auto_created: true,
                payload_url: this.payloadUrl(spaceId),
                last_delivery_at: new Date(this.now().getTime() - 20 * 60_000).toISOString(),
              }
            : null,
        },
      };
      this.vaults.set(spaceId, v);
    }
    return v;
  }

  private vaultSummary(spaceId: string): { provider: 'managed' | 'github'; repo: string | null } {
    const { provider, repo } = this.vault(spaceId).status;
    return { provider, repo };
  }

  private payloadUrl(spaceId: string): string {
    const origin = globalThis.location?.origin ?? 'http://localhost:8787';
    return `${origin}/webhooks/github/${spaceId}`;
  }

  private ownedVault(spaceId: string): MockVault {
    const space = this.me().spaces.find((s) => s.id === spaceId);
    if (!space) throw problem(404, 'Not found', 'No such space.');
    if (space.role !== 'owner') {
      throw problem(403, 'Forbidden', 'Only the space owner can manage its vault.');
    }
    return this.vault(spaceId);
  }

  private connectVault(spaceId: string, body: unknown): ConnectGitHubVaultResponse {
    const v = this.ownedVault(spaceId);
    if (!this.vaultKek) {
      throw problem(503, 'Not configured', 'GitHub vaults need VAULT_KEK set on the server.');
    }
    const req = (body ?? {}) as Partial<ConnectGitHubVaultInput>;
    const errors: { path: string; message: string }[] = [];
    if (typeof req.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(req.repo)) {
      errors.push({ path: 'repo', message: 'repo must be "owner/name"' });
    }
    if (typeof req.token !== 'string' || req.token.length < 10) {
      errors.push({ path: 'token', message: 'Too small: expected string to have >=10 characters' });
    }
    if (req.direction !== 'push_managed' && req.direction !== 'adopt_repo') {
      errors.push({ path: 'direction', message: 'Invalid option' });
    }
    if (errors.length) {
      throw new HttpProblem({
        type: 'https://second-brain.dev/problems/validation',
        title: 'Invalid input',
        status: 422,
        errors,
      });
    }
    const repo = req.repo as string;
    const token = req.token as string;
    if (v.status.provider === 'github') {
      throw problem(
        409,
        'Conflict',
        'This space is already connected to GitHub. Disconnect it first.',
      );
    }
    if (token.includes('revoked')) {
      throw problem(
        400,
        'GitHub rejected the token',
        'GitHub answered 401. Check that the token is correct and has not expired or been revoked.',
      );
    }
    if (repo.split('/')[0] === 'missing') {
      throw problem(
        400,
        'Repository not found',
        `${repo} does not exist, or the token has no access to it.`,
      );
    }
    if (token.includes('readonly')) {
      throw problem(
        400,
        'The token lacks permission',
        `The token can read ${repo} but not write to it.`,
      );
    }
    const branch = req.branch || 'main';
    const repoNotes = repo.includes('existing') ? 12 : 0;
    const managedNotes = this.notes.size;
    if (req.direction === 'push_managed' && repoNotes > 0 && !req.confirm_overwrite) {
      throw new HttpProblem({
        type: 'https://second-brain.dev/problems/conflict',
        title: 'Conflict',
        status: 409,
        detail: `${repo}@${branch} already has ${repoNotes} notes. Pass confirm_overwrite: true to export on top of them, or use adopt_repo.`,
        repo_notes: repoNotes,
      });
    }
    if (req.direction === 'adopt_repo' && managedNotes > 0 && !req.confirm_overwrite) {
      throw new HttpProblem({
        type: 'https://second-brain.dev/problems/conflict',
        title: 'Conflict',
        status: 409,
        detail: `This space has ${managedNotes} notes that the repository's notes would replace. Pass confirm_overwrite: true, or use push_managed to keep them.`,
        managed_notes: managedNotes,
      });
    }
    const created = req.create_webhook !== false && !token.includes('nohooks');
    const sha = randomHex(20);
    const now = this.now().toISOString();
    v.token = token;
    v.status = {
      space_id: spaceId,
      provider: 'github',
      repo,
      branch,
      last_synced_sha: sha,
      last_synced_at: now,
      last_sync_error: null,
      webhook: {
        configured: created,
        auto_created: created,
        payload_url: this.payloadUrl(spaceId),
        last_delivery_at: null,
      },
    };
    const pushing = req.direction === 'push_managed';
    return {
      vault: v.status,
      direction: req.direction as ConnectGitHubVaultResponse['direction'],
      exported: pushing ? managedNotes : 0,
      indexed: pushing ? managedNotes + repoNotes : Math.max(repoNotes, 5),
      commit_sha: pushing && managedNotes > 0 ? sha : null,
      webhook: {
        payload_url: this.payloadUrl(spaceId),
        content_type: 'application/json',
        secret: randomHex(20),
        events: ['push'],
        created,
        detail: created
          ? null
          : req.create_webhook === false
            ? 'You chose to add the webhook yourself.'
            : 'The token cannot manage webhooks (it needs "Webhooks: Read and write"). Add it by hand.',
      },
    };
  }

  private disconnectVault(spaceId: string, skipImport: boolean): DisconnectGitHubVaultResponse {
    const v = this.ownedVault(spaceId);
    if (v.status.provider !== 'github') {
      throw problem(409, 'Conflict', 'This space is not connected to GitHub.');
    }
    if (!skipImport && v.token?.includes('revoked')) {
      throw problem(
        400,
        'GitHub rejected the token',
        'GitHub answered 401. Check that the token is correct and has not expired or been revoked.',
      );
    }
    const webhookRemoved = Boolean(v.status.webhook?.auto_created);
    v.token = null;
    v.status = {
      space_id: spaceId,
      provider: 'managed',
      repo: null,
      branch: null,
      last_synced_sha: null,
      last_synced_at: null,
      last_sync_error: null,
      webhook: null,
    };
    return {
      vault: v.status,
      imported: skipImport ? 0 : 3,
      removed: 0,
      commit_sha: skipImport ? null : randomHex(20),
      webhook_removed: webhookRemoved,
    };
  }

  private me(): MeResponse {
    return {
      user: { id: 'usr_01JB6Z0000000000000000000A', email: 'alex@example.com', name: 'Alex Doe' },
      spaces: [
        {
          id: 'spc_personal',
          name: 'Personal',
          kind: 'personal',
          role: 'owner',
          vault: this.vaultSummary('spc_personal'),
        },
        {
          id: 'spc_acme',
          name: 'Acme Platform',
          kind: 'team',
          role: 'editor',
          vault: this.vaultSummary('spc_acme'),
        },
      ],
      default_space_id: 'spc_personal',
    };
  }

  private listNotes(q: URLSearchParams): Page<NoteSummary> {
    const type = q.get('type');
    const project = q.get('project');
    const limitRaw = Number(q.get('limit') ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 50;
    if (type && !(NOTE_TYPES as string[]).includes(type)) {
      throw problem(400, 'Invalid input', `Unknown type "${type}".`);
    }
    const offset = Number(q.get('cursor') ?? 0) || 0;
    const all = this.allSummaries().filter(
      (n) => (!type || n.type === type) && (!project || n.project === project),
    );
    const items = all.slice(offset, offset + limit);
    const next = offset + limit < all.length ? String(offset + limit) : null;
    return { items, next_cursor: next };
  }

  private save(body: unknown): SaveNoteResponse {
    if (typeof body !== 'object' || body === null) throw problem(400, 'Invalid input');
    const req = body as Partial<SaveNoteRequest>;
    if (typeof req.path !== 'string' || typeof req.content !== 'string') {
      throw problem(400, 'Invalid input', 'path and content are required.');
    }
    if (req.content.length > 200_000)
      throw problem(413, 'Too large', 'Notes are limited to 200 KB.');
    let path: string;
    try {
      path = normalizeVaultPath(req.path, { forWrite: true });
    } catch (err) {
      throw problem(400, 'Invalid path', err instanceof InvalidPathError ? err.message : undefined);
    }
    const existing = this.notes.get(path);
    const base = req.base_version ?? null;
    if (existing && base === null) {
      throw problem(409, 'Conflict', `A note already exists at ${path}.`);
    }
    if (!existing && base !== null) {
      throw problem(409, 'Conflict', `${path} was deleted or moved since you opened it.`);
    }
    if (existing && base !== existing.version) {
      throw problem(409, 'Conflict', `${path} changed since you opened it.`);
    }
    const version = this.nextVersion();
    this.notes.set(path, { raw: req.content, version, updatedAt: this.now().toISOString() });
    return { path, version, commit_sha: randomHex(20) };
  }

  private search(q: URLSearchParams): SearchResponse {
    const query = (q.get('q') ?? '').trim();
    if (!query) return { hits: [], mode: 'keyword' };
    const types = (q.get('types') ?? '').split(',').filter(Boolean);
    const project = q.get('project');
    const limit = Math.min(50, Math.max(1, Number(q.get('limit') ?? 20) || 20));
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
      .filter(Boolean);
    if (!terms.length) return { hits: [], mode: 'keyword' };

    const hits: SearchHit[] = [];
    for (const [path, note] of this.notes) {
      const s = this.summary(path, note);
      if (types.length && !types.includes(s.type)) continue;
      if (project && s.project !== project) continue;
      const { body } = parseNote(note.raw);
      const titleLower = s.title.toLowerCase();
      let best: SearchHit | null = null;
      for (const chunk of chunkNote(s.title, body)) {
        const text = chunk.body.toLowerCase();
        let score = 0;
        for (const t of terms) {
          const count = text.split(t).length - 1;
          if (count === 0 && !titleLower.includes(t)) {
            score = 0;
            break;
          }
          score += Math.log1p(count) + (titleLower.includes(t) ? 2 : 0);
        }
        if (score > 0 && (!best || score > best.score)) {
          best = {
            path,
            title: s.title,
            type: s.type,
            heading: chunk.headingPath.join(' › '),
            snippet: makeSnippet(chunk.body, terms),
            score: Math.round(score * 1000) / 1000,
          };
        }
      }
      if (best) hits.push(best);
    }
    hits.sort((a, b) => b.score - a.score);
    return { hits: hits.slice(0, limit), mode: 'keyword' };
  }

  private dashboard(): DashboardResponse {
    const summaries = this.allSummaries();
    const sessions = summaries
      .filter((s) => s.type === 'session')
      .slice(0, 5)
      .map((s) => {
        const note = this.notes.get(s.path);
        const fm = note ? parseNote(note.raw).frontmatter : {};
        return {
          id: asString(fm.id) ?? s.path,
          date: (asString(fm.saved) ?? s.updated_at).slice(0, 10),
          summary: asString(fm.summary) ?? s.title,
          project: s.project,
          path: s.path,
        };
      });
    const decisions: DashboardResponse['recent_decisions'] = [];
    for (const s of summaries.filter((n) => n.type === 'decision-log')) {
      const note = this.notes.get(s.path);
      if (!note) continue;
      for (const d of parseDecisionLog(parseNote(note.raw).body)) {
        if (d.status === 'superseded') continue;
        decisions.push({
          id: d.id,
          title: d.title,
          date: d.date,
          project: s.project,
          path: s.path,
        });
      }
    }
    decisions.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    let decisionCount = 0;
    for (const s of summaries.filter((n) => n.type === 'decision-log')) {
      const note = this.notes.get(s.path);
      if (note) decisionCount += parseDecisionLog(parseNote(note.raw).body).length;
    }
    return {
      projects: this.projectSummaries().filter((p) => p.status === 'active'),
      recent_sessions: sessions,
      recent_decisions: decisions.slice(0, 5),
      check: this.check(),
      stats: {
        notes: summaries.length,
        topics: summaries.filter((s) => s.type === 'topic').length,
        decisions: decisionCount,
        sessions: summaries.filter((s) => s.type === 'session').length,
      },
    };
  }

  private createKey(body: unknown): CreateKeyResponse {
    const req = (body ?? {}) as Partial<CreateKeyInput>;
    const label = typeof req.label === 'string' ? req.label.trim() : '';
    if (!label || label.length > 80) {
      throw new HttpProblem({
        type: 'https://second-brain.dev/problems/validation',
        title: 'Invalid input',
        status: 422,
        detail: 'Give the key a label of 1–80 characters.',
        errors: [{ path: 'label', message: 'Required, at most 80 characters' }],
      });
    }
    const scopes: KeyScope[] =
      Array.isArray(req.scopes) && req.scopes.length ? req.scopes : ['read', 'write'];
    const now = this.now();
    const secretBody = randomBase62(40);
    const key: ApiKey = {
      id: `key_${randomHex(13).toUpperCase()}`,
      label,
      machine: req.machine?.trim() || null,
      client: req.client?.trim() || null,
      prefix: `sb_live_${secretBody.slice(0, 4)}`,
      scopes,
      space_id: 'spc_personal',
      project: req.project?.trim() || null,
      created_at: now.toISOString(),
      last_used_at: null,
      expires_at: req.expires_in_days
        ? new Date(now.getTime() + req.expires_in_days * 86_400_000).toISOString()
        : null,
      revoked_at: null,
    };
    this.keys.unshift(key);
    return { key, secret: `sb_live_${secretBody}` };
  }

  private deviceInfo(code: string): DeviceRequestInfo {
    const req = this.devices.get(code.toUpperCase());
    if (!req || req.status !== 'pending') {
      throw problem(404, 'Not found', 'This code is not valid. Check it in your terminal.');
    }
    if (new Date(req.info.expires_at).getTime() < this.now().getTime()) {
      throw problem(410, 'Expired', 'This code has expired. Run the sign-in command again.');
    }
    return req.info;
  }

  private approveDevice(body: unknown): void {
    const req = (body ?? {}) as Partial<DeviceApproveInput>;
    if (typeof req.user_code !== 'string' || typeof req.approve !== 'boolean') {
      throw problem(400, 'Invalid input', 'user_code and approve are required.');
    }
    const info = this.deviceInfo(req.user_code);
    const pending = this.devices.get(info.user_code);
    if (!pending) throw problem(404, 'Not found');
    pending.status = req.approve ? 'approved' : 'denied';
    if (req.approve) {
      this.createKey({
        label: `${info.machine} · ${info.client}`,
        machine: info.machine,
        client: info.client,
        scopes: req.scopes,
        project: req.project,
      });
    }
  }

  // ── Router ────────────────────────────────────────────────────────────────

  /** A `fetch`-compatible handler. */
  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const url = new URL(input, 'http://mock.local');
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, '');
    let body: unknown;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        return problemResponse(problem(400, 'Invalid JSON'));
      }
    }
    try {
      return this.route(method, path, url.searchParams, body);
    } catch (err) {
      if (err instanceof HttpProblem) return problemResponse(err);
      return problemResponse(
        problem(500, 'Server error', 'The mock server hit an unexpected error.'),
      );
    }
  };

  private route(method: string, path: string, q: URLSearchParams, body: unknown): Response {
    // Public endpoints.
    if (method === 'GET' && path === '/auth/providers') {
      const providers: AuthProviders = { passkey: true, google: true, magic_link: this.magicLink };
      return json(200, providers);
    }
    if (method === 'POST' && path === '/auth/passkey/login/options') {
      this.loginChallenge = randomBase64Url(32);
      const options: PasskeyLoginOptionsResponse = {
        challenge: this.loginChallenge,
        rpId: globalThis.location?.hostname ?? 'localhost',
        allowCredentials: [],
        userVerification: 'preferred',
        timeout: 60_000,
      };
      return json(200, options);
    }
    if (method === 'POST' && path === '/auth/passkey/login/verify') {
      const id = (body as { response?: { id?: unknown } } | undefined)?.response?.id;
      if (!this.loginChallenge || typeof id !== 'string') {
        throw problem(400, 'Invalid passkey response', 'Start the passkey sign-in again.');
      }
      // A real server checks the signature against the stored public key. The mock trusts it.
      this.loginChallenge = null;
      this.setSignedIn(true);
      return json(200, { verified: true });
    }
    if (method === 'GET' && path === '/auth/google/start') {
      // The real endpoint redirects to Google and back; the mock just signs you in.
      this.setSignedIn(true);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && path === '/auth/magic-link') {
      const { email, next } = (body ?? {}) as { email?: unknown; next?: unknown };
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new HttpProblem({
          type: 'https://second-brain.dev/problems/validation',
          title: 'Invalid input',
          status: 422,
          detail: 'Enter a valid email address.',
          errors: [{ path: 'email', message: 'Invalid email' }],
        });
      }
      if (next !== undefined && typeof next !== 'string') {
        throw new HttpProblem({
          type: 'https://second-brain.dev/problems/validation',
          title: 'Invalid input',
          status: 422,
          errors: [{ path: 'next', message: 'Expected a string' }],
        });
      }
      const token = randomHex(16);
      this.magicTokens.add(token);
      const res: MagicLinkResponse = {
        sent: true,
        dev_link: `/api/v1/auth/verify?token=${token}`,
      };
      return json(202, res);
    }
    if (method === 'GET' && path === '/auth/verify') {
      const token = q.get('token') ?? '';
      if (!this.magicTokens.delete(token)) {
        throw problem(400, 'Invalid link', 'This sign-in link was already used or has expired.');
      }
      this.setSignedIn(true);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && path === '/auth/logout') {
      this.setSignedIn(false);
      return new Response(null, { status: 204 });
    }

    this.requireAuth();

    if (method === 'GET' && path === '/me') return json(200, this.me());
    if (method === 'POST' && path === '/auth/passkey/register/options') {
      const me = this.me();
      this.registerChallenge = randomBase64Url(32);
      const options: PasskeyRegisterOptionsResponse = {
        challenge: this.registerChallenge,
        rp: { name: 'Second Brain', id: globalThis.location?.hostname ?? 'localhost' },
        user: {
          id: randomBase64Url(16),
          name: me.user.email,
          displayName: me.user.name ?? me.user.email,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        timeout: 60_000,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        excludeCredentials: this.passkeys.map((k) => ({ id: k.id, type: 'public-key' })),
      };
      return json(200, options);
    }
    if (method === 'POST' && path === '/auth/passkey/register/verify') {
      const req = body as { response?: { id?: unknown }; name?: unknown } | undefined;
      const id = req?.response?.id;
      if (!this.registerChallenge || typeof id !== 'string') {
        throw problem(400, 'Invalid passkey response', 'Start adding the passkey again.');
      }
      this.registerChallenge = null;
      this.passkeys.push({
        id,
        name: typeof req?.name === 'string' && req.name.trim() ? req.name.trim() : 'Passkey',
        created_at: this.now().toISOString(),
        last_used_at: null,
        transports: ['internal'],
      });
      return json(200, { verified: true });
    }
    if (method === 'GET' && path === '/auth/passkeys') return json(200, this.passkeys);
    const passkeyMatch = /^\/auth\/passkeys\/([^/]+)$/.exec(path);
    if (passkeyMatch) {
      const id = decodeURIComponent(passkeyMatch[1] ?? '');
      const index = this.passkeys.findIndex((k) => k.id === id);
      const found = this.passkeys[index];
      if (!found) throw problem(404, 'Not found', 'No such passkey.');
      if (method === 'PATCH') {
        const name = (body as { name?: unknown } | undefined)?.name;
        if (typeof name !== 'string' || !name.trim() || name.length > 60) {
          throw problem(400, 'Invalid input', 'Give the passkey a name of up to 60 characters.');
        }
        found.name = name.trim();
        return json(200, found);
      }
      if (method === 'DELETE') {
        // Google is offered by the mock too, but an account only has it if it signed in with it.
        if (this.passkeys.length === 1 && !this.magicLink) {
          throw problem(
            409,
            'Last sign-in method',
            'Add another passkey before removing this one, or you will be locked out.',
          );
        }
        this.passkeys.splice(index, 1);
        return new Response(null, { status: 204 });
      }
    }
    if (method === 'GET' && path === '/oauth/grants') {
      return json(200, { items: this.oauthGrants, next_cursor: null } satisfies Page<OAuthGrant>);
    }
    const oauthMatch = /^\/oauth\/grants\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && oauthMatch) {
      const id = decodeURIComponent(oauthMatch[1] ?? '');
      const before = this.oauthGrants.length;
      this.oauthGrants = this.oauthGrants.filter((g) => g.id !== id);
      if (this.oauthGrants.length === before) throw problem(404, 'Not found', 'No such app.');
      return new Response(null, { status: 204 });
    }
    const vaultMatch = /^\/spaces\/([^/]+)\/vault(\/github)?$/.exec(path);
    if (vaultMatch) {
      const spaceId = decodeURIComponent(vaultMatch[1] ?? '');
      if (method === 'GET' && !vaultMatch[2]) return json(200, this.ownedVault(spaceId).status);
      if (method === 'POST' && vaultMatch[2]) return json(201, this.connectVault(spaceId, body));
      if (method === 'DELETE' && vaultMatch[2]) {
        return json(200, this.disconnectVault(spaceId, q.get('skip_import') === 'true'));
      }
    }
    if (method === 'GET' && path === '/dashboard') return json(200, this.dashboard());
    if (method === 'GET' && path === '/notes') return json(200, this.listNotes(q));
    if (method === 'GET' && path === '/note') {
      const p = q.get('path');
      if (!p) throw problem(400, 'Invalid input', 'path is required.');
      return json(200, this.detail(p));
    }
    if (method === 'PUT' && path === '/note') return json(200, this.save(body));
    if (method === 'GET' && path === '/search') return json(200, this.search(q));
    if (method === 'GET' && path === '/projects') {
      const status = q.get('status');
      if (status && !PROJECT_STATUSES.includes(status)) {
        throw problem(400, 'Invalid input', `Unknown status "${status}".`);
      }
      const items = this.projectSummaries().filter((p) => !status || p.status === status);
      return json(200, { items });
    }
    if (method === 'GET' && path === '/keys') {
      return json(200, { items: this.keys, next_cursor: null } satisfies Page<ApiKey>);
    }
    if (method === 'POST' && path === '/keys') return json(201, this.createKey(body));
    const keyMatch = /^\/keys\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && keyMatch) {
      const id = decodeURIComponent(keyMatch[1] ?? '');
      const key = this.keys.find((k) => k.id === id);
      if (!key) throw problem(404, 'Not found', 'No such key.');
      key.revoked_at ??= this.now().toISOString();
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && path === '/connect') {
      const origin = globalThis.location?.origin ?? 'http://localhost:8787';
      const info: ConnectInfo = { mcp_url: `${origin}/mcp`, api_url: `${origin}/api/v1` };
      return json(200, info);
    }
    if (method === 'POST' && path === '/auth/device/approve') {
      this.approveDevice(body);
      return new Response(null, { status: 204 });
    }
    const deviceMatch = /^\/auth\/device\/([^/]+)$/.exec(path);
    if (method === 'GET' && deviceMatch) {
      return json(200, this.deviceInfo(decodeURIComponent(deviceMatch[1] ?? '')));
    }
    throw problem(404, 'Not found', `No mock route for ${method} ${path}.`);
  }

  // ── Dev helpers ───────────────────────────────────────────────────────────

  /** Appends a line to a note as if another device saved it, bumping its version. */
  simulateRemoteEdit(path: string): void {
    const note = this.notes.get(path);
    if (!note) throw new Error('Unknown note');
    const stamp = this.now().toISOString().slice(0, 16).replace('T', ' ');
    this.notes.set(path, {
      raw: `${note.raw.trimEnd()}\n\n> Edited on another device at ${stamp} UTC.\n`,
      version: this.nextVersion(),
      updatedAt: this.now().toISOString(),
    });
  }
}

function problemResponse(err: HttpProblem): Response {
  return new Response(JSON.stringify(err.problem), {
    status: err.problem.status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

/** A ~160 character excerpt around the first matching term, on word boundaries. */
function makeSnippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  const start = Math.max(0, idx - 60);
  const end = Math.min(flat.length, start + 160);
  let snippet = flat.slice(start, end);
  if (start > 0) snippet = `…${snippet.replace(/^\S*\s/, '')}`;
  if (end < flat.length) snippet = `${snippet.replace(/\s\S*$/, '')}…`;
  // Like the server: matches are wrapped in **…**.
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return snippet.replace(/\*\*/g, '').replace(new RegExp(`(${escaped.join('|')})`, 'gi'), '**$1**');
}

export function createMockApi(opts: MockServerOptions = {}): {
  api: ApiClient;
  server: MockServer;
} {
  const server = new MockServer(opts);
  const api = createHttpClient({
    mode: 'mock',
    fetch: server.fetch,
    openLink: async (url) => {
      const res = await server.fetch(url);
      if (!res.ok) throw new Error('This sign-in link was already used or has expired.');
    },
    dev: {
      simulateRemoteEdit: async (path) => server.simulateRemoteEdit(path),
    },
  });
  return { api, server };
}
