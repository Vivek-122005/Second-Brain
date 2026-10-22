import {
  type CommitMeta,
  type FileChange,
  VaultConflictError,
  type VaultFileVersion,
  type VaultStore,
} from './types';

const API = 'https://api.github.com';
/** Files at or above this size are not read into the vault (GitHub's blob API limit is 100 MB). */
const MAX_FILE_BYTES = 1_000_000;
/** Bounded parallelism keeps us under Workers' subrequest limits and GitHub's secondary limits. */
const PARALLEL = 8;

export const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** A GitHub API call that failed in a way the caller can't recover from by retrying the save. */
export class GitHubError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface GitHubRepoInfo {
  full_name: string;
  default_branch: string;
  private: boolean;
  /** The token owner's permissions on the repository (absent for some token types). */
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export interface GitHubCompare {
  /** `ahead`: head is a descendant of base. `diverged`/`behind` mean history was rewritten. */
  status: 'ahead' | 'behind' | 'identical' | 'diverged';
  total_commits: number;
  files: { filename: string; status: string; previous_filename?: string }[];
}

/** Compare responses list at most 300 files; at that size we treat the list as incomplete. */
export const COMPARE_FILE_LIMIT = 300;

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * GitHub vault (ADR-0001): one repository per space, accessed with a fine-grained token that has
 * Contents read/write on that repository only. Writes use the Git Trees API so a multi-file save
 * is a single commit, and the branch ref is updated fast-forward only: if someone pushed in the
 * meantime the update fails and the caller retries on the new head.
 */
export class GitHubVaultStore implements VaultStore {
  readonly provider = 'github' as const;
  readonly repo: string;
  private readonly base: string;

  constructor(
    repo: string,
    readonly branch: string,
    private readonly token: string,
    // Resolve the global at call time: workerd rejects `fetch` invoked with a foreign `this`.
    private readonly fetcher: Fetcher = (input, init) => fetch(input, init),
  ) {
    if (!REPO_PATTERN.test(repo)) throw new Error('repo must be "owner/name"');
    this.repo = repo;
    this.base = `${API}/repos/${repo}`;
  }

  /** Raw API call. Returns 4xx statuses to the caller; throws GitHubError for 401/403/5xx. */
  private async gh<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await this.fetcher(`${this.base}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'second-brain',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await res.text();
    let body = null as T;
    try {
      body = (text ? JSON.parse(text) : null) as T;
    } catch {
      // Non-JSON error pages: the status is what matters.
    }
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      throw new GitHubError(
        res.status,
        `GitHub ${init.method ?? 'GET'} ${path.split('?')[0]} failed with ${res.status}`,
      );
    }
    return { status: res.status, body };
  }

  private refPath(): string {
    return this.branch.split('/').map(encodeURIComponent).join('/');
  }

  /** Repository metadata; null when it does not exist or the token cannot see it. */
  async repoInfo(): Promise<GitHubRepoInfo | null> {
    const r = await this.gh<GitHubRepoInfo>('');
    return r.status === 200 ? r.body : null;
  }

  async head(): Promise<string | null> {
    const r = await this.gh<{ object: { sha: string } }>(`/git/ref/heads/${this.refPath()}`);
    if (r.status === 404 || r.status === 409) return null; // missing branch or empty repository
    if (r.status !== 200) throw new GitHubError(r.status, `GitHub ref lookup failed (${r.status})`);
    return r.body.object.sha;
  }

  async read(path: string, ref: string = this.branch): Promise<VaultFileVersion | null> {
    const r = await this.gh<{ content?: string; encoding?: string; sha: string; type: string }>(
      `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    );
    if (r.status === 404) return null;
    if (r.status !== 200) throw new GitHubError(r.status, `GitHub read failed (${r.status})`);
    if (r.body.type !== 'file' || r.body.encoding !== 'base64' || r.body.content === undefined)
      return null;
    return { path, content: decodeBase64Utf8(r.body.content), sha: r.body.sha };
  }

  /**
   * Reads specific paths at a commit (incremental sync). A path that does not exist at `ref` maps
   * to null, which the caller treats as a deletion.
   */
  async readPaths(paths: string[], ref: string): Promise<Map<string, VaultFileVersion | null>> {
    const out = new Map<string, VaultFileVersion | null>();
    for (let i = 0; i < paths.length; i += PARALLEL) {
      const slice = paths.slice(i, i + PARALLEL);
      const files = await Promise.all(slice.map((p) => this.read(p, ref)));
      slice.forEach((p, j) => out.set(p, files[j] ?? null));
    }
    return out;
  }

  /** Every blob path at head (no content). Empty for an empty repository or missing branch. */
  async listPaths(): Promise<string[]> {
    const head = await this.head();
    if (!head) return [];
    const tree = await this.gh<{ tree: { path: string; type: string }[] }>(
      `/git/trees/${head}?recursive=1`,
    );
    return tree.body.tree.filter((t) => t.type === 'blob').map((t) => t.path);
  }

  async readAll(): Promise<VaultFileVersion[]> {
    const head = await this.head();
    if (!head) return [];
    const tree = await this.gh<{
      tree: { path: string; type: string; sha: string; size?: number }[];
      truncated: boolean;
    }>(`/git/trees/${head}?recursive=1`);
    const blobs = tree.body.tree.filter(
      (t) => t.type === 'blob' && /\.md$/i.test(t.path) && (t.size ?? 0) < MAX_FILE_BYTES,
    );
    const out: VaultFileVersion[] = [];
    for (let i = 0; i < blobs.length; i += PARALLEL) {
      const slice = blobs.slice(i, i + PARALLEL);
      const files = await Promise.all(
        slice.map(async (b) => {
          const r = await this.gh<{ content: string }>(`/git/blobs/${b.sha}`);
          return { path: b.path, content: decodeBase64Utf8(r.body.content), sha: b.sha };
        }),
      );
      out.push(...files);
    }
    return out;
  }

  /** Files changed between two commits; null when either commit is unknown (e.g. force-push). */
  async compare(base: string, head: string): Promise<GitHubCompare | null> {
    const r = await this.gh<GitHubCompare>(
      `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=${COMPARE_FILE_LIMIT}`,
    );
    if (r.status === 404 || r.status === 422) return null;
    if (r.status !== 200) throw new GitHubError(r.status, `GitHub compare failed (${r.status})`);
    return { ...r.body, files: r.body.files ?? [] };
  }

  /**
   * Creates (or, when one already exists for the URL, updates) a push webhook. Needs the
   * "Webhooks: read and write" repository permission; returns null when the token lacks it so the
   * caller can fall back to manual setup.
   */
  async ensureWebhook(url: string, secret: string): Promise<number | null> {
    const config = { url, content_type: 'json', secret, insecure_ssl: '0' };
    try {
      const created = await this.gh<{ id: number }>('/hooks', {
        method: 'POST',
        body: JSON.stringify({ name: 'web', active: true, events: ['push'], config }),
      });
      if (created.status === 201) return created.body.id;
      if (created.status !== 422) return null;
      // 422: a hook for this URL exists already (reconnect). Rotate its secret.
      const hooks = await this.gh<{ id: number; config: { url?: string } }[]>('/hooks');
      const existing = hooks.status === 200 ? hooks.body.find((h) => h.config.url === url) : null;
      if (!existing) return null;
      const updated = await this.gh(`/hooks/${existing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: true, events: ['push'], config }),
      });
      return updated.status === 200 ? existing.id : null;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 403) return null;
      throw err;
    }
  }

  async deleteWebhook(id: number): Promise<boolean> {
    try {
      const r = await this.gh(`/hooks/${id}`, { method: 'DELETE' });
      return r.status === 204 || r.status === 404;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 403) return false;
      throw err;
    }
  }

  async commit(
    changes: FileChange[],
    meta: CommitMeta,
    expectedHead: string | null,
  ): Promise<string> {
    const head = await this.head();
    if (head !== expectedHead) throw new VaultConflictError();

    const tree = await this.createTree(changes, head);
    if (tree === 'empty-repository') return this.bootstrap(changes, meta);

    const commit = await this.gh<{ sha: string }>('/git/commits', {
      method: 'POST',
      body: JSON.stringify({
        message: meta.message,
        tree,
        parents: head ? [head] : [],
        author: { ...meta.author, date: new Date().toISOString() },
      }),
    });
    if (commit.status >= 400) throw new Error(`GitHub commit creation failed (${commit.status})`);

    const ref = head
      ? await this.gh(`/git/refs/heads/${this.refPath()}`, {
          method: 'PATCH',
          body: JSON.stringify({ sha: commit.body.sha, force: false }),
        })
      : await this.gh('/git/refs', {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${this.branch}`, sha: commit.body.sha }),
        });
    if (ref.status === 422 || ref.status === 409) throw new VaultConflictError();
    if (ref.status >= 400) throw new Error(`GitHub ref update failed (${ref.status})`);
    return commit.body.sha;
  }

  private async createTree(
    changes: FileChange[],
    head: string | null,
  ): Promise<string | 'empty-repository'> {
    const entries = changes
      // A root commit has nothing to delete.
      .filter((c) => head !== null || c.content !== null)
      .map((c) =>
        c.content === null
          ? { path: c.path, mode: '100644', type: 'blob', sha: null }
          : { path: c.path, mode: '100644', type: 'blob', content: c.content },
      );
    const tree = await this.gh<{ sha: string }>('/git/trees', {
      method: 'POST',
      body: JSON.stringify({
        ...(head ? { base_tree: (await this.commitTree(head)) ?? undefined } : {}),
        tree: entries,
      }),
    });
    // The Git Data API refuses to work on a repository with no commits at all.
    if (tree.status === 409 && head === null) return 'empty-repository';
    if (tree.status >= 400) throw new Error(`GitHub tree creation failed (${tree.status})`);
    return tree.body.sha;
  }

  /**
   * First commit in an empty repository. GitHub only accepts it through the Contents API (one
   * file), so we seed the branch with one file, then write the full tree as a root commit and
   * move the branch onto it. The branch ends up with exactly one commit holding every file. The
   * forced move is safe: it only replaces the seed commit we created a moment ago, and we check
   * that nobody else moved the branch in between.
   */
  private async bootstrap(changes: FileChange[], meta: CommitMeta): Promise<string> {
    const files = changes.filter((c): c is { path: string; content: string } => c.content !== null);
    const first = files[0];
    if (!first) throw new Error('Nothing to commit');
    const seed = await this.gh<{ commit: { sha: string } }>(`/contents/${encodePath(first.path)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: meta.message,
        content: encodeBase64Utf8(first.content),
        branch: this.branch,
        author: meta.author,
      }),
    });
    if (seed.status === 409 || seed.status === 422) throw new VaultConflictError();
    if (seed.status >= 400) throw new Error(`GitHub initial commit failed (${seed.status})`);
    if (files.length === 1) return seed.body.commit.sha;

    const tree = await this.createTree(files, null);
    if (tree === 'empty-repository') throw new Error('GitHub repository is still empty');
    const commit = await this.gh<{ sha: string }>('/git/commits', {
      method: 'POST',
      body: JSON.stringify({
        message: meta.message,
        tree,
        parents: [],
        author: { ...meta.author, date: new Date().toISOString() },
      }),
    });
    if (commit.status >= 400) throw new Error(`GitHub commit creation failed (${commit.status})`);
    if ((await this.head()) !== seed.body.commit.sha) throw new VaultConflictError();
    const ref = await this.gh(`/git/refs/heads/${this.refPath()}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.body.sha, force: true }),
    });
    if (ref.status >= 400) throw new Error(`GitHub ref update failed (${ref.status})`);
    return commit.body.sha;
  }

  private async commitTree(commitSha: string): Promise<string | null> {
    const r = await this.gh<{ tree: { sha: string } }>(`/git/commits/${commitSha}`);
    return r.status === 200 ? r.body.tree.sha : null;
  }
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}
