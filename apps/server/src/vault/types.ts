/**
 * VaultStore: the source of truth for note content (ADR-0001, ADR-0008). Implementations: the
 * managed store (files in D1, versioned commits) and GitHub (Git Trees API).
 */

export interface VaultFileVersion {
  path: string;
  content: string;
  /** Content hash in the store's own format (SHA-256 for managed, Git blob SHA for GitHub). */
  sha: string;
}

export interface FileChange {
  path: string;
  /** New content, or null to delete the file. */
  content: string | null;
}

export interface CommitMeta {
  message: string;
  /** Who made the change, e.g. "Vivek via claude-code (key sb_live_ab12)". */
  author: { name: string; email: string };
}

/** Thrown when the vault moved since `expectedHead`; callers re-read and retry. */
export class VaultConflictError extends Error {
  constructor(message = 'The vault changed while saving; retry.') {
    super(message);
    this.name = 'VaultConflictError';
  }
}

export interface VaultStore {
  readonly provider: 'managed' | 'github';
  /** Current head commit id, or null for an empty vault. */
  head(): Promise<string | null>;
  read(path: string): Promise<VaultFileVersion | null>;
  /** Every file (paths and content) at head. Used by full rebuilds. */
  readAll(): Promise<VaultFileVersion[]>;
  /**
   * Applies all changes as one atomic commit on top of `expectedHead`. Throws VaultConflictError
   * when the head moved. Returns the new head.
   */
  commit(changes: FileChange[], meta: CommitMeta, expectedHead: string | null): Promise<string>;
}
