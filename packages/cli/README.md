# `brain`: the Second Brain CLI

Signs a machine in to Second Brain, keeps its API key in the OS keychain, and connects your AI
assistants (Claude Code, Cursor, Claude Desktop, VS Code) to the Second Brain MCP server.

## Install

From this monorepo (Node 22+, pnpm 10):

```sh
pnpm install
pnpm --filter @second-brain/cli build
node packages/cli/dist/index.js --help   # or: pnpm --filter @second-brain/cli exec brain
```

To put `brain` on your PATH while developing: `cd packages/cli && pnpm link --global`.
`pnpm --filter @second-brain/cli dev` rebuilds on change.

The bundle in `dist/index.js` inlines the workspace packages; its only runtime dependency is
[`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node), which ships prebuilt binaries
(no compiler needed).

## Usage

```sh
brain login [--api <url>] [--client <name>] [--machine <name>] [--no-browser]
brain status
brain connect <claude-code | cursor | claude-desktop | vscode> [--dry-run] [--reuse-key]
brain keys
brain logout
brain help [command]
brain --version
```

### `brain login`

Starts a device login: prints a short code and a link, opens your browser, and waits while you
approve the request in the web app. The resulting key is stored in the OS keychain.

The server URL comes from `--api`, then `$SECOND_BRAIN_API_URL`, then the saved config, then
`http://localhost:8787`. Plain `http://` is refused for anything but localhost (set
`SECOND_BRAIN_ALLOW_HTTP=1` for a trusted private network). Signing in again replaces the stored
key and revokes the old one.

### `brain connect <client>`

Configures an assistant to use `<server>/mcp` with a bearer key:

| Client         | How                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude-code    | Runs `claude mcp add --transport http --scope user second-brain <mcp_url> --header "Authorization: Bearer …"`. Without `claude` on PATH, prints the command (key masked).          |
| cursor         | Merges `mcpServers.second-brain` (`url` + `headers`) into `~/.cursor/mcp.json`.                                                                                                 |
| vscode         | Merges `servers.second-brain` (`type: http`) into the user `mcp.json` (`~/Library/Application Support/Code/User`, `%APPDATA%\Code\User`, `~/.config/Code/User`), or prints it. |
| claude-desktop | Merges an `npx -y mcp-remote <mcp_url> --header Authorization:${SECOND_BRAIN_AUTH}` entry, with the key in `env`, into `claude_desktop_config.json` (macOS, Windows).           |

- Each assistant gets **its own key**, labelled `<client> on <machine>`, so you can revoke one
  without breaking the others. Reconnecting the same assistant revokes the key it replaced.
  `--reuse-key` uses this machine's login key instead.
- Other servers in the file are kept. Before the first change the original is copied to
  `<file>.bak` (never overwritten afterwards). Files that contain a key are written with mode 0600.
  JSONC comments are not preserved in the rewritten file; the backup keeps them.
- `--dry-run` shows what would change and creates no key. `--config <file>` targets a different
  config file (e.g. VS Code Insiders).
- When a snippet has to be pasted by hand, the key is masked. `--show-secret` prints it with a
  freshly created key instead.

### `brain status`, `brain keys`, `brain logout`

`status` shows the server, signed-in user, key prefix and scopes. `keys` lists your API keys
(prefix, label, client, machine, last used, status). `logout` revokes this machine's login key and
deletes it locally; keys used by connected assistants are left alone.

## Where things are stored

| What                     | Where                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| API key secret           | OS keychain: service `second-brain`, account `<api origin>` (macOS Keychain, Windows Credential Manager, Secret Service) |
| Fallback (no keychain)   | `~/.second-brain/credentials.json`, mode 0600, with a one-line warning                                            |
| Config (no secrets)      | `~/.second-brain/config.json`: API/MCP URLs, key id, prefix, scopes, connected assistants                          |
| Activity spool (groundwork) | `~/.second-brain/spool/<YYYY-MM-DD>.jsonl`, redacted before writing, capped at 50 MB                           |

The CLI never prints a full secret; it shows the prefix (`sb_live_ab12…`).

## Environment

| Variable                    | Effect                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| `SECOND_BRAIN_API_URL`      | Default server URL                                                  |
| `SECOND_BRAIN_HOME`         | Use this directory instead of `~/.second-brain`                     |
| `SECOND_BRAIN_KEYCHAIN=off` | Skip the OS keychain and use the 0600 credentials file              |
| `SECOND_BRAIN_ALLOW_HTTP=1` | Allow plain HTTP to a non-localhost server                          |
| `SECOND_BRAIN_NO_BROWSER=1` | Never open a browser during login                                   |
| `NO_COLOR` / `FORCE_COLOR`  | Turn colour off / on                                                |
| `SECOND_BRAIN_DEBUG=1`      | Print stack traces for unexpected errors                            |

## Exit codes

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| 0    | Success                                         |
| 1    | Error (API error, file could not be parsed, …)  |
| 2    | Usage error (unknown command, option, argument) |
| 3    | Not signed in, or the server rejected the key   |
| 4    | Login denied in the browser or the code expired |
| 5    | Server unreachable                              |

## Development

```sh
pnpm --filter @second-brain/cli test        # Vitest: mocked fetch, temp SECOND_BRAIN_HOME, fake keychain
pnpm --filter @second-brain/cli typecheck
```

Commands receive a `Ctx` (env, home dir, fetch, keychain loader, clock, process runner) instead of
reaching for globals, so tests never touch your real keychain or assistant configs.
