import { vi } from 'vitest';

/**
 * An in-memory GitHub REST API (the subset the GitHub vault uses), installed as a mock for the
 * global `fetch`. It models blobs, trees, commits, refs, the contents and compare endpoints and
 * repository webhooks closely enough to test real flows: fast-forward-only ref updates, the
 * "Git Repository is empty" 409 for the Git Data API, token scoping and hook permissions.
 * Unmatched hosts throw, so a test can never reach the network.
 */

interface Commit {
  tree: string;
  parents: string[];
  message: string;
}

export interface FakeRepo {
  fullName: string;
  defaultBranch: string;
  token: string;
  canWrite: boolean;
  canHooks: boolean;
  blobs: Map<string, string>;
  trees: Map<string, Map<string, string>>;
  commits: Map<string, Commit>;
  refs: Map<string, string>;
  hooks: { id: number; events: string[]; config: { url: string; secret: string } }[];
}

export interface FakePush {
  ref: string;
  before: string;
  after: string;
  added: string[];
  modified: string[];
  removed: string[];
}

const ZERO = '0'.repeat(40);

function b64(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function unb64(text: string): string {
  const bin = atob(text);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export class FakeGitHub {
  readonly repos = new Map<string, FakeRepo>();
  /** Every request as `METHOD /path` relative to the repository (`?query` dropped). */
  log: string[] = [];
  private counter = 0;
  private hookIds = 100;

  private sha(kind: string): string {
    this.counter += 1;
    return `${kind}${this.counter.toString(16)}`.padEnd(40, '0').slice(0, 40);
  }

  createRepo(
    fullName: string,
    opts: {
      token: string;
      defaultBranch?: string;
      canWrite?: boolean;
      canHooks?: boolean;
      files?: Record<string, string>;
    },
  ): FakeRepo {
    const repo: FakeRepo = {
      fullName,
      defaultBranch: opts.defaultBranch ?? 'main',
      token: opts.token,
      canWrite: opts.canWrite ?? true,
      canHooks: opts.canHooks ?? false,
      blobs: new Map(),
      trees: new Map(),
      commits: new Map(),
      refs: new Map(),
      hooks: [],
    };
    this.repos.set(fullName.toLowerCase(), repo);
    if (opts.files) this.push(fullName, repo.defaultBranch, opts.files, 'Initial commit');
    return repo;
  }

  /** A `git push` of one commit by someone else (Obsidian, VS Code). */
  push(
    fullName: string,
    branch: string,
    changes: Record<string, string | null>,
    message = 'Edit notes',
  ): FakePush {
    const repo = this.repo(fullName);
    const before = repo.refs.get(branch) ?? null;
    const base = before ? this.treeOf(repo, before) : new Map<string, string>();
    const tree = new Map(base);
    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) {
        if (tree.delete(path)) removed.push(path);
        continue;
      }
      (tree.has(path) ? modified : added).push(path);
      tree.set(path, this.blob(repo, content));
    }
    const after = this.commit(repo, tree, before ? [before] : [], message);
    repo.refs.set(branch, after);
    return { ref: `refs/heads/${branch}`, before: before ?? ZERO, after, added, modified, removed };
  }

  /** Files on a branch, as `{path: content}`. */
  files(fullName: string, branch = 'main'): Record<string, string> {
    const repo = this.repo(fullName);
    const head = repo.refs.get(branch);
    if (!head) return {};
    const out: Record<string, string> = {};
    for (const [path, sha] of this.treeOf(repo, head)) out[path] = repo.blobs.get(sha) ?? '';
    return out;
  }

  /** Commits reachable from a branch head. */
  history(fullName: string, branch = 'main'): string[] {
    const repo = this.repo(fullName);
    const out: string[] = [];
    const queue = [repo.refs.get(branch)].filter((s): s is string => !!s);
    while (queue.length) {
      const sha = queue.shift() as string;
      if (out.includes(sha)) continue;
      out.push(sha);
      queue.push(...(repo.commits.get(sha)?.parents ?? []));
    }
    return out;
  }

  install(): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) =>
      this.handle(new Request(input as RequestInfo, init)),
    );
  }

  repo(fullName: string): FakeRepo {
    const repo = this.repos.get(fullName.toLowerCase());
    if (!repo) throw new Error(`fake repo ${fullName} does not exist`);
    return repo;
  }

  private blob(repo: FakeRepo, content: string): string {
    const sha = this.sha('b');
    repo.blobs.set(sha, content);
    return sha;
  }

  private commit(repo: FakeRepo, tree: Map<string, string>, parents: string[], message: string) {
    const treeSha = this.sha('t');
    repo.trees.set(treeSha, tree);
    const sha = this.sha('c');
    repo.commits.set(sha, { tree: treeSha, parents, message });
    return sha;
  }

  private treeOf(repo: FakeRepo, commitOrTree: string): Map<string, string> {
    const c = repo.commits.get(commitOrTree);
    return repo.trees.get(c ? c.tree : commitOrTree) ?? new Map();
  }

  private resolve(repo: FakeRepo, ref: string): string | null {
    if (repo.commits.has(ref)) return ref;
    return repo.refs.get(ref) ?? null;
  }

  private isAncestor(repo: FakeRepo, ancestor: string, of: string): boolean {
    const queue = [of];
    const seen = new Set<string>();
    while (queue.length) {
      const sha = queue.shift() as string;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      queue.push(...(repo.commits.get(sha)?.parents ?? []));
    }
    return false;
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.hostname !== 'api.github.com') throw new Error(`unexpected fetch to ${url.host}`);
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return json(404, { message: 'Not Found' });
    const path = decodeURIComponent(m[2] ?? '');
    this.log.push(`${req.method} ${path}`);

    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const known = [...this.repos.values()].some((r) => r.token === token);
    if (!known) return json(401, { message: 'Bad credentials' });
    const repo = this.repos.get((m[1] ?? '').toLowerCase());
    if (!repo || repo.token !== token) return json(404, { message: 'Not Found' });
    const body = req.method === 'GET' ? null : ((await req.json().catch(() => null)) as never);
    const write = req.method !== 'GET';
    const empty = repo.commits.size === 0;
    if (write && !path.startsWith('/hooks') && !repo.canWrite) {
      return json(403, { message: 'Resource not accessible by personal access token' });
    }

    if (path === '' && req.method === 'GET') {
      return json(200, {
        full_name: repo.fullName,
        default_branch: repo.defaultBranch,
        private: true,
        permissions: { admin: false, push: repo.canWrite, pull: true },
      });
    }

    let r: RegExpExecArray | null;
    if ((r = /^\/git\/ref\/heads\/(.+)$/.exec(path)) && req.method === 'GET') {
      if (empty) return json(409, { message: 'Git Repository is empty.' });
      const sha = repo.refs.get(r[1] as string);
      return sha ? json(200, { object: { sha } }) : json(404, { message: 'Not Found' });
    }
    if ((r = /^\/git\/commits\/(\w+)$/.exec(path)) && req.method === 'GET') {
      const c = repo.commits.get(r[1] as string);
      return c ? json(200, { sha: r[1], tree: { sha: c.tree } }) : json(404, {});
    }
    if ((r = /^\/git\/trees\/(\w+)$/.exec(path)) && req.method === 'GET') {
      const tree = this.treeOf(repo, r[1] as string);
      const dirs = new Set<string>();
      for (const p of tree.keys()) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
      }
      return json(200, {
        truncated: false,
        tree: [
          ...[...dirs].map((d) => ({ path: d, type: 'tree', sha: this.sha('d') })),
          ...[...tree].map(([p, sha]) => ({
            path: p,
            type: 'blob',
            sha,
            size: (repo.blobs.get(sha) ?? '').length,
          })),
        ],
      });
    }
    if ((r = /^\/git\/blobs\/(\w+)$/.exec(path)) && req.method === 'GET') {
      const content = repo.blobs.get(r[1] as string);
      return content === undefined
        ? json(404, {})
        : json(200, { content: b64(content), encoding: 'base64' });
    }
    if (path === '/git/trees' && req.method === 'POST') {
      if (empty) return json(409, { message: 'Git Repository is empty.' });
      const input = body as unknown as {
        base_tree?: string;
        tree: { path: string; sha?: string | null; content?: string }[];
      };
      const tree = new Map(input.base_tree ? this.treeOf(repo, input.base_tree) : []);
      for (const e of input.tree) {
        if (e.content !== undefined) tree.set(e.path, this.blob(repo, e.content));
        else if (e.sha === null) tree.delete(e.path);
      }
      const sha = this.sha('t');
      repo.trees.set(sha, tree);
      return json(201, { sha });
    }
    if (path === '/git/commits' && req.method === 'POST') {
      const input = body as unknown as { tree: string; parents: string[]; message: string };
      const sha = this.sha('c');
      repo.commits.set(sha, input);
      return json(201, { sha });
    }
    if ((r = /^\/git\/refs\/heads\/(.+)$/.exec(path)) && req.method === 'PATCH') {
      const input = body as unknown as { sha: string; force?: boolean };
      const branch = r[1] as string;
      const current = repo.refs.get(branch);
      if (!current) return json(422, { message: 'Reference does not exist' });
      if (!input.force && !this.isAncestor(repo, current, input.sha)) {
        return json(422, { message: 'Update is not a fast forward' });
      }
      repo.refs.set(branch, input.sha);
      return json(200, { object: { sha: input.sha } });
    }
    if (path === '/git/refs' && req.method === 'POST') {
      const input = body as unknown as { ref: string; sha: string };
      const branch = input.ref.replace(/^refs\/heads\//, '');
      if (repo.refs.has(branch)) return json(422, { message: 'Reference already exists' });
      repo.refs.set(branch, input.sha);
      return json(201, { ref: input.ref, object: { sha: input.sha } });
    }
    if ((r = /^\/contents\/(.+)$/.exec(path))) {
      const file = r[1] as string;
      if (req.method === 'GET') {
        const commit = this.resolve(repo, url.searchParams.get('ref') ?? repo.defaultBranch);
        const sha = commit ? this.treeOf(repo, commit).get(file) : undefined;
        if (!sha) return json(404, { message: 'Not Found' });
        return json(200, {
          type: 'file',
          encoding: 'base64',
          content: b64(repo.blobs.get(sha) ?? ''),
          sha,
        });
      }
      if (req.method === 'PUT') {
        const input = body as unknown as { message: string; content: string; branch?: string };
        const branch = input.branch ?? repo.defaultBranch;
        const before = repo.refs.get(branch);
        if (!empty && !before) return json(404, { message: 'Branch not found' });
        const tree = new Map(before ? this.treeOf(repo, before) : []);
        tree.set(file, this.blob(repo, unb64(input.content)));
        const sha = this.commit(repo, tree, before ? [before] : [], input.message);
        repo.refs.set(branch, sha);
        return json(201, { content: { sha: tree.get(file) }, commit: { sha } });
      }
    }
    if ((r = /^\/compare\/(\w+)\.\.\.(\w+)$/.exec(path)) && req.method === 'GET') {
      const [base, head] = [r[1] as string, r[2] as string];
      if (!repo.commits.has(base) || !repo.commits.has(head)) return json(404, {});
      const status =
        base === head
          ? 'identical'
          : this.isAncestor(repo, base, head)
            ? 'ahead'
            : this.isAncestor(repo, head, base)
              ? 'behind'
              : 'diverged';
      const a = this.treeOf(repo, base);
      const b = this.treeOf(repo, head);
      const files: { filename: string; status: string }[] = [];
      for (const [p, sha] of b) {
        if (!a.has(p)) files.push({ filename: p, status: 'added' });
        else if (a.get(p) !== sha && repo.blobs.get(a.get(p) as string) !== repo.blobs.get(sha))
          files.push({ filename: p, status: 'modified' });
      }
      for (const p of a.keys()) if (!b.has(p)) files.push({ filename: p, status: 'removed' });
      return json(200, { status, total_commits: 1, files });
    }
    if (path.startsWith('/hooks')) {
      if (!repo.canHooks) {
        return json(403, { message: 'Resource not accessible by personal access token' });
      }
      if (path === '/hooks' && req.method === 'GET') return json(200, repo.hooks);
      if (path === '/hooks' && req.method === 'POST') {
        const input = body as unknown as {
          events: string[];
          config: FakeRepo['hooks'][0]['config'];
        };
        if (repo.hooks.some((h) => h.config.url === input.config.url)) {
          return json(422, { message: 'Hook already exists on this repository' });
        }
        const hook = { id: (this.hookIds += 1), events: input.events, config: input.config };
        repo.hooks.push(hook);
        return json(201, hook);
      }
      const id = Number(/^\/hooks\/(\d+)$/.exec(path)?.[1]);
      const hook = repo.hooks.find((h) => h.id === id);
      if (!hook) return json(404, {});
      if (req.method === 'PATCH') {
        const input = body as unknown as { config: FakeRepo['hooks'][0]['config'] };
        hook.config = input.config;
        return json(200, hook);
      }
      if (req.method === 'DELETE') {
        repo.hooks = repo.hooks.filter((h) => h.id !== id);
        return json(204);
      }
    }
    return json(404, { message: `fake GitHub has no ${req.method} ${path}` });
  }
}
