export type ClientId = 'claude-code' | 'cursor' | 'claude-desktop' | 'vscode';

export interface ClientSnippet {
  id: ClientId;
  label: string;
  /** Where the snippet goes. */
  where: string;
  language: 'shell' | 'json';
  code: string;
}

export const KEY_PLACEHOLDER = '<YOUR_API_KEY>';

/**
 * One-click setup snippets for MCP clients (FR-WEB-04). The secret is only embedded when the
 * caller has it (right after creating a key); otherwise a placeholder is shown.
 */
export function buildSnippets(mcpUrl: string, secret?: string): ClientSnippet[] {
  const key = secret ?? KEY_PLACEHOLDER;
  const bearer = `Bearer ${key}`;
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      where: 'Run in a terminal',
      language: 'shell',
      code: `claude mcp add --transport http second-brain ${mcpUrl} \\\n  --header "Authorization: ${bearer}"`,
    },
    {
      id: 'cursor',
      label: 'Cursor',
      where: '~/.cursor/mcp.json',
      language: 'json',
      code: JSON.stringify(
        { mcpServers: { 'second-brain': { url: mcpUrl, headers: { Authorization: bearer } } } },
        null,
        2,
      ),
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      where: 'Settings › Developer › Edit Config (claude_desktop_config.json)',
      language: 'json',
      code: JSON.stringify(
        {
          mcpServers: {
            'second-brain': {
              command: 'npx',
              args: ['-y', 'mcp-remote', mcpUrl, '--header', 'Authorization:${SB_AUTH}'],
              env: { SB_AUTH: bearer },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'vscode',
      label: 'VS Code',
      where: '.vscode/mcp.json (VS Code asks for the key once and stores it securely)',
      language: 'json',
      code: JSON.stringify(
        {
          inputs: [
            {
              type: 'promptString',
              id: 'second-brain-key',
              description: 'Second Brain API key',
              password: true,
            },
          ],
          servers: {
            'second-brain': {
              type: 'http',
              url: mcpUrl,
              headers: { Authorization: 'Bearer ${input:second-brain-key}' },
            },
          },
        },
        null,
        2,
      ),
    },
  ];
}

export const CLIENT_OPTIONS: { value: string; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'claude-desktop', label: 'Claude Desktop' },
  { value: 'vscode', label: 'VS Code' },
  { value: 'other', label: 'Other' },
];

export function clientLabel(client: string | null): string | null {
  if (!client) return null;
  return CLIENT_OPTIONS.find((c) => c.value === client)?.label ?? client;
}
