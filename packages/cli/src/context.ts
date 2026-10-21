import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KeyringModule } from './secrets';

/** Minimal writable stream surface used for terminal output. */
export interface OutStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Everything the CLI needs from the outside world. Commands receive this instead of touching
 * `process`, `fetch` or the filesystem roots directly, so tests can run against a temp home,
 * a mocked `fetch` and a fake keychain.
 */
export interface Ctx {
  env: Record<string, string | undefined>;
  homedir: string;
  platform: NodeJS.Platform;
  hostname: string;
  stdout: OutStream;
  stderr: OutStream;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Best effort; resolves `false` when no opener could be started. */
  openUrl(url: string): Promise<boolean>;
  /** Absolute path of an executable on PATH, or null. */
  which(cmd: string): string | null;
  exec(file: string, args: string[]): Promise<ExecResult>;
  /** Loads the native keychain binding; null when it is not installed for this platform. */
  loadKeyring(): Promise<KeyringModule | null>;
}

function isExecutable(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function whichSync(
  cmd: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts =
    platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())]
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

function openerFor(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  // `start` is a cmd.exe builtin; the empty string is the window title.
  // Passed verbatim (see below), so the quotes reach cmd.exe and `&` in the URL stays literal.
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', `"${url.replace(/"/g, '')}"`]];
  return ['xdg-open', [url]];
}

export function defaultContext(): Ctx {
  const platform = process.platform;
  const env = process.env;
  return {
    env,
    homedir: os.homedir(),
    platform,
    hostname: os.hostname(),
    stdout: process.stdout,
    stderr: process.stderr,
    fetch: (...args) => globalThis.fetch(...args),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    openUrl: (url) =>
      new Promise((resolve) => {
        const [cmd, args] = openerFor(platform, url);
        try {
          const child = spawn(cmd, args, {
            stdio: 'ignore',
            detached: true,
            windowsVerbatimArguments: platform === 'win32',
          });
          child.once('error', () => resolve(false));
          child.once('spawn', () => {
            child.unref();
            resolve(true);
          });
        } catch {
          resolve(false);
        }
      }),
    which: (cmd) => whichSync(cmd, env, platform),
    exec: (file, args) =>
      new Promise((resolve) => {
        // Windows .cmd/.bat shims cannot be started without a shell.
        const shell = platform === 'win32' && /\.(cmd|bat)$/i.test(file);
        const quoted = shell ? args.map((a) => `"${a.replace(/"/g, '""')}"`) : args;
        execFile(
          shell ? `"${file}"` : file,
          quoted,
          { shell, timeout: 60_000, windowsHide: true },
          (error, stdout, stderr) => {
            const code =
              error && typeof (error as { code?: unknown }).code === 'number'
                ? ((error as { code: number }).code ?? 1)
                : error
                  ? 1
                  : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          },
        );
      }),
    loadKeyring: async () => {
      try {
        return (await import('@napi-rs/keyring')) as unknown as KeyringModule;
      } catch {
        return null;
      }
    },
  };
}
