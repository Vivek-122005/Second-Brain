import { existsSync } from 'node:fs';
import path from 'node:path';
import { isLocalHost } from './config';
import type { Ctx } from './context';
import { shellQuote } from './output';

export const CLIENT_IDS = ['claude-code', 'cursor', 'claude-desktop', 'vscode'] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

export function isClientId(v: string): v is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(v);
}

/** Name of our entry in every client's MCP server list. */
export const SERVER_NAME = 'second-brain';

export const CLIENT_NAMES: Record<ClientId, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  'claude-desktop': 'Claude Desktop',
  vscode: 'VS Code',
};

type JsonObject = Record<string, unknown>;

/** How a client gets configured. */
export type Target =
  /** Merge `entry(secret)` into `<container>.second-brain` of a JSON(C) file. */
  | {
      kind: 'file';
      path: string;
      container: 'mcpServers' | 'servers';
      entry(secret: string): JsonObject;
      /** Shown when the client does not look installed (we still write the file). */
      note?: string;
    }
  /** Run the client's own CLI (`claude mcp add …`). Each array is one invocation. */
  | { kind: 'command'; bin: string; commands(secret: string): string[][] }
  /** Nothing we can safely write; print instructions instead. */
  | { kind: 'print'; reason: string; render(secret: string): string };

export interface TargetOptions {
  mcpUrl: string;
  /** Override the config file location (`--config <file>`). */
  configFile?: string;
}

export function claudeCodeCommands(mcpUrl: string, secret: string): string[][] {
  return [
    // `mcp add` refuses to overwrite, so drop any previous entry first (failure is fine).
    ['mcp', 'remove', '--scope', 'user', SERVER_NAME],
    [
      'mcp',
      'add',
      '--transport',
      'http',
      '--scope',
      'user',
      SERVER_NAME,
      mcpUrl,
      '--header',
      `Authorization: Bearer ${secret}`,
    ],
  ];
}

export function cursorEntry(mcpUrl: string, secret: string): JsonObject {
  return { url: mcpUrl, headers: { Authorization: `Bearer ${secret}` } };
}

export function vscodeEntry(mcpUrl: string, secret: string): JsonObject {
  return { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${secret}` } };
}

/**
 * Claude Desktop only speaks stdio to local servers from its config file, so we bridge with
 * `mcp-remote`. The key is passed through `env` rather than inlined in `args`, and the header has
 * no space after the colon because Claude Desktop on Windows mangles spaces inside arguments.
 */
export function claudeDesktopEntry(mcpUrl: string, secret: string): JsonObject {
  const args = ['-y', 'mcp-remote', mcpUrl, '--header', 'Authorization:${SECOND_BRAIN_AUTH}'];
  const url = new URL(mcpUrl);
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) args.push('--allow-http');
  return { command: 'npx', args, env: { SECOND_BRAIN_AUTH: `Bearer ${secret}` } };
}

function appData(ctx: Ctx): string {
  return ctx.env.APPDATA ?? path.join(ctx.homedir, 'AppData', 'Roaming');
}

/** VS Code's user profile directory (`…/Code/User`). */
export function vscodeUserDir(ctx: Ctx): string {
  if (ctx.platform === 'darwin') {
    return path.join(ctx.homedir, 'Library', 'Application Support', 'Code', 'User');
  }
  if (ctx.platform === 'win32') return path.join(appData(ctx), 'Code', 'User');
  const xdg = ctx.env.XDG_CONFIG_HOME ?? path.join(ctx.homedir, '.config');
  return path.join(xdg, 'Code', 'User');
}

export function claudeDesktopConfigPath(ctx: Ctx): string | null {
  if (ctx.platform === 'darwin') {
    return path.join(
      ctx.homedir,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }
  if (ctx.platform === 'win32')
    return path.join(appData(ctx), 'Claude', 'claude_desktop_config.json');
  return null;
}

function snippet(container: string, entry: JsonObject): string {
  return JSON.stringify({ [container]: { [SERVER_NAME]: entry } }, null, 2);
}

export function resolveTarget(ctx: Ctx, client: ClientId, opts: TargetOptions): Target {
  const { mcpUrl } = opts;
  switch (client) {
    case 'claude-code': {
      const bin = ctx.which('claude');
      if (bin) return { kind: 'command', bin, commands: (s) => claudeCodeCommands(mcpUrl, s) };
      return {
        kind: 'print',
        reason: 'The `claude` command was not found on your PATH.',
        render: (s) => ['claude', ...claudeCodeCommands(mcpUrl, s)[1]!].map(shellQuote).join(' '),
      };
    }
    case 'cursor': {
      const dir = path.join(ctx.homedir, '.cursor');
      return {
        kind: 'file',
        path: opts.configFile ?? path.join(dir, 'mcp.json'),
        container: 'mcpServers',
        entry: (s) => cursorEntry(mcpUrl, s),
        note:
          existsSync(dir) || opts.configFile
            ? undefined
            : 'Cursor does not look installed (~/.cursor not found); writing the config anyway.',
      };
    }
    case 'vscode': {
      const userDir = vscodeUserDir(ctx);
      if (opts.configFile || existsSync(userDir)) {
        return {
          kind: 'file',
          path: opts.configFile ?? path.join(userDir, 'mcp.json'),
          container: 'servers',
          entry: (s) => vscodeEntry(mcpUrl, s),
        };
      }
      return {
        kind: 'print',
        reason: `VS Code's user settings folder was not found (${userDir}).`,
        render: (s) =>
          `Add this to your user mcp.json (Command Palette → "MCP: Open User Configuration"):\n\n${snippet('servers', vscodeEntry(mcpUrl, s))}`,
      };
    }
    case 'claude-desktop': {
      const file = opts.configFile ?? claudeDesktopConfigPath(ctx);
      if (file) {
        return {
          kind: 'file',
          path: file,
          container: 'mcpServers',
          entry: (s) => claudeDesktopEntry(mcpUrl, s),
        };
      }
      return {
        kind: 'print',
        reason:
          'Claude Desktop is only available on macOS and Windows (use --config <file> to target a custom path).',
        render: (s) =>
          `Add this to claude_desktop_config.json:\n\n${snippet('mcpServers', claudeDesktopEntry(mcpUrl, s))}`,
      };
    }
  }
}
