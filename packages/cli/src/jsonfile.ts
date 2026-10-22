import { chmod, copyFile, readFile, stat } from 'node:fs/promises';
import { writeTextFile } from './config';
import { CliError, ExitCode } from './errors';

/**
 * Strips `//` and `/* *\/` comments and trailing commas so JSONC files (VS Code's `mcp.json`,
 * hand-edited Cursor configs) can be parsed. String contents are left untouched.
 */
export function stripJsonc(text: string): string {
  return removeTrailingCommas(stripComments(text));
}

function stripComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Drops a `,` followed only by whitespace before `}` or `]`, outside strings. */
function removeTrailingCommas(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface MergePlan {
  path: string;
  exists: boolean;
  /** Top-level key holding the servers: `mcpServers` (Cursor, Claude Desktop) or `servers` (VS Code). */
  container: string;
  name: string;
  action: 'add' | 'replace' | 'unchanged';
  /** Other servers in the file that are kept as they are. */
  preserved: string[];
  backupPath: string;
  /** True when `<file>.bak` will be (or was) written by this change. */
  createsBackup: boolean;
  /** The original had comments, which a JSON rewrite drops (the `.bak` keeps them). */
  dropsComments: boolean;
  next: JsonObject;
}

/** Computes how `name` would be merged into `file` without writing anything. */
export async function planServerMerge(
  file: string,
  container: string,
  name: string,
  entry: JsonObject,
): Promise<MergePlan> {
  let text: string | undefined;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  let root: JsonObject = {};
  let dropsComments = false;
  if (text !== undefined && text.trim() !== '') {
    const stripped = stripJsonc(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch (err) {
      throw new CliError(
        `Could not parse ${file}: ${(err as Error).message}`,
        ExitCode.Error,
        'Fix the file by hand (nothing was changed), then run the command again.',
      );
    }
    if (!isObject(parsed)) {
      throw new CliError(`${file} does not contain a JSON object; nothing was changed.`);
    }
    root = parsed;
    dropsComments = stripComments(text) !== text;
  }

  const servers = root[container] ?? {};
  if (!isObject(servers)) {
    throw new CliError(`"${container}" in ${file} is not an object; nothing was changed.`);
  }
  const previous = servers[name];
  const action =
    previous === undefined
      ? 'add'
      : JSON.stringify(previous) === JSON.stringify(entry)
        ? 'unchanged'
        : 'replace';
  const backupPath = `${file}.bak`;
  const backupExists = await stat(backupPath).then(
    () => true,
    () => false,
  );

  return {
    path: file,
    exists: text !== undefined,
    container,
    name,
    action,
    preserved: Object.keys(servers).filter((k) => k !== name),
    backupPath,
    createsBackup: text !== undefined && action !== 'unchanged' && !backupExists,
    dropsComments: dropsComments && action !== 'unchanged',
    next: { ...root, [container]: { ...servers, [name]: entry } },
  };
}

/**
 * Applies a plan: backs up the original to `<file>.bak` the first time we change it (an existing
 * `.bak` is never overwritten, so it keeps the pre-Second-Brain version), then writes the merged
 * JSON atomically with mode 0600 because it contains an API key.
 */
export async function applyServerMerge(plan: MergePlan): Promise<void> {
  if (plan.action === 'unchanged') {
    await chmod(plan.path, 0o600).catch(() => undefined);
    return;
  }
  if (plan.createsBackup) {
    await copyFile(plan.path, plan.backupPath);
    await chmod(plan.backupPath, 0o600);
  }
  await writeTextFile(plan.path, JSON.stringify(plan.next, null, 2) + '\n', 0o600);
}
