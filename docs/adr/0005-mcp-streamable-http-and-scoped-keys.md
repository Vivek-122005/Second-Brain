# ADR-0005: MCP over Streamable HTTP with per-machine scoped keys and OAuth 2.1

- Status: accepted
- Date: 2026-10-21

## Context
Many clients (Claude Code/Desktop, Cursor, VS Code, custom agents) must connect remotely and securely, and losing one machine must not compromise everything.

## Decision
Expose a single remote MCP endpoint (`/mcp`, Streamable HTTP). Authenticate either with bearer API keys issued per machine and per client (scoped read/write, optionally restricted to a space or project, stored as HMAC hashes, kept in the OS keychain by the CLI) or with OAuth 2.1 + PKCE for clients that support it.

## Consequences
- Fine-grained revocation and audit attribution per device and agent.
- We need a CLI to make key setup painless (`brain login`, `brain connect`).
