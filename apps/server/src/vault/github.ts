import {
  type CommitMeta,
  type FileChange,
  VaultConflictError,
  type VaultFileVersion,
  type VaultStore,
} from './types';

/**
 * GitHub vault (ADR-0001): one repository per space, accessed with a fine-grained token that has
 * Contents read/write on that repository only. Writes use the Git Trees API so a multi-file save
 * is a single commit, and the branch ref is updated fast-forward only: if someone pushed in the
 * meantime the update fails and the caller retries on the new head.
 */
export class GitHubVaultStore implements VaultStore {
  readonly provider = 'github' as const;
  private readonly base: string;

  constructor(
    repo: string,
    private readonly branch: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must be "owner/name"');
    this.base = `https://api.github.com/repos/${repo}`;
  }

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
    const body = (text ? JSON.parse(text) : null) as T;
    if (res.status >= 500 || res.status === 401 || res.status === 403) {
      throw new Error(`GitHub ${init.method ?? 'GET'} ${path} failed with ${res.status}`);
    }
    return { status: res.status, body };
  }

  async head(): Promise<string | null> {
    const r = await this.gh<{ object: { sha: string } }>(
      `/git/ref/heads/${encodeURIComponent(this.branch)}`,
    );
    if (r.status === 404 || r.status === 409) return null; // missing branch or empty repository
    return r.body.object.sha;
  }

  async read(path: string): Promise<VaultFileVersion | null> {
    const r = await this.gh<{ content?: string; encoding?: string; sha: string; type: string }>(
      `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (r.status === 404) return null;
    if (r.body.type !== 'file' || r.body.encoding !== 'base64' || r.body.content === undefined)
      return null;
    return { path, content: decodeBase64Utf8(r.body.content), sha: r.body.sha };
  }

  async readAll(): Promise<VaultFileVersion[]> {
    const head = await this.head();
    if (!head) return [];
    const tree = await this.gh<{
      tree: { path: string; type: string; sha: string; size?: number }[];
      truncated: boolean;
    }>(`/git/trees/${head}?recursive=1`);
    const blobs = tree.body.tree.filter(
      (t) => t.type === 'blob' && /\.md$/i.test(t.path) && (t.size ?? 0) < 1_000_000,
    );
    const out: VaultFileVersion[] = [];
    // Bounded parallelism keeps us under Workers' subrequest limits and GitHub's secondary limits.
    for (let i = 0; i < blobs.length; i += 10) {
      const slice = blobs.slice(i, i + 10);
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

  async commit(
    changes: FileChange[],
    meta: CommitMeta,
    expectedHead: string | null,
  ): Promise<string> {
    const head = await this.head();
    if (head !== expectedHead) throw new VaultConflictError();

    const tree = await this.gh<{ sha: string }>('/git/trees', {
      method: 'POST',
      body: JSON.stringify({
        ...(head ? { base_tree: (await this.commitTree(head)) ?? undefined } : {}),
        tree: changes.map((c) =>
          c.content === null
            ? { path: c.path, mode: '100644', type: 'blob', sha: null }
            : { path: c.path, mode: '100644', type: 'blob', content: c.content },
        ),
      }),
    });
    if (tree.status >= 400) throw new Error(`GitHub tree creation failed (${tree.status})`);

    const commit = await this.gh<{ sha: string }>('/git/commits', {
      method: 'POST',
      body: JSON.stringify({
        message: meta.message,
        tree: tree.body.sha,
        parents: head ? [head] : [],
        author: { ...meta.author, date: new Date().toISOString() },
      }),
    });
    if (commit.status >= 400) throw new Error(`GitHub commit creation failed (${commit.status})`);

    const ref = head
      ? await this.gh(`/git/refs/heads/${encodeURIComponent(this.branch)}`, {
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

  private async commitTree(commitSha: string): Promise<string | null> {
    const r = await this.gh<{ tree: { sha: string } }>(`/git/commits/${commitSha}`);
    return r.status === 200 ? r.body.tree.sha : null;
  }
}

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
