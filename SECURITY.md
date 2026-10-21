# Security Policy

Second Brain stores people's and teams' working memory, so we treat security reports as a top priority. Our design is described in [Security & encryption](docs/03-security/security.md).

## Reporting a vulnerability
- **Do not** open a public issue or PR.
- Report privately through GitHub: **Security → Advisories → Report a vulnerability** on this repository. Include steps to reproduce, impact and affected versions.
- We aim to acknowledge within **3 business days** and give a remediation plan within **10 business days**.
- Please give us a reasonable window to fix the issue before public disclosure. We credit reporters who wish to be named.

## Scope
In scope: the API Worker (MCP, REST, webhooks, OAuth), the web app, the `brain` CLI and hooks, and tenant isolation. Especially interesting: cross-tenant or cross-space data access, key/scope bypass, secret leakage past the redactor, and prompt injection that causes unintended writes.

Out of scope: denial of service by volume, social engineering, and issues in third-party services (report those to the vendor).

## Supported versions
Pre-release: only `main` is supported. After 1.0, the latest minor release receives security fixes.
