# ADR-0007: Build our own authentication (passkeys, Google OIDC, opaque tokens, OAuth 2.1)

- Status: accepted
- Date: 2026-10-21
- Supersedes: roadmap OD-3 leaning (WorkOS / Clerk)

## Context
Second Brain stores people's most private working memory, and it must run self-hosted with no paid identity vendor. It needs four kinds of sign-in:

1. People signing in to the web app.
2. The `brain` CLI signing in a machine.
3. MCP clients (Claude, Cursor, …) connecting remotely.
4. Later, businesses using single sign-on.

A hosted identity provider (Clerk, Auth0, WorkOS) would be faster to wire up. But it adds a vendor that sees every login, recurring cost, and a dependency self-hosters can't run.

## Decision
We implement authentication ourselves on vetted primitives (Web Crypto, `@simplewebauthn/server`), with no external identity provider required.

| Need | Mechanism |
|---|---|
| Web sign-in (primary) | **Passkeys (WebAuthn)**: phishing-resistant, no passwords stored, works with Touch ID / Windows Hello / phone |
| Web sign-in (optional) | **Sign in with Google** via OpenID Connect (authorization code + PKCE + `state` + `nonce`), implemented in-house. Enabled when `GOOGLE_CLIENT_ID/SECRET` are configured |
| Web sign-in (fallback / recovery) | **Email magic link** (single-use, 15 min, hashed). Delivery is pluggable: console in dev, an email API in production when configured |
| Browser session | **Opaque random token** (256-bit) in an `HttpOnly; Secure; SameSite=Lax` cookie; only its SHA-256 hash is stored in D1; 30-day sliding expiry; instantly revocable |
| CLI | **Device authorization grant** (RFC 8628): `brain login` shows a code, the user approves in the browser, the CLI receives a scoped API key and stores it in the OS keychain |
| Scripts / hooks / MCP (simple) | **API keys** `sb_live_<id>_<secret>`, per machine and client, scoped (`read`/`write`, optional space/project), stored as HMAC-SHA256 with a server pepper |
| MCP clients (standard) | **Our own OAuth 2.1 authorization server**: metadata (RFC 8414), protected-resource metadata (RFC 9728), dynamic client registration (RFC 7591), authorization code + PKCE (S256 only), rotating refresh tokens. Access tokens are opaque and hashed, valid 1 h |
| Business SSO (Phase 5) | Generic OIDC (any IdP: Google Workspace, Microsoft Entra, Okta) reusing the Google OIDC code path; SAML only if a customer requires it |

**Why opaque tokens instead of JWTs?** Every request already reads D1 to check permissions, so self-contained tokens save nothing. Opaque tokens can be revoked immediately, which is what sharing and "sign out everywhere" need, and they can't be forged if a signing key leaks.

## Consequences
- No identity vendor, no per-user auth cost, and self-hosting works out of the box.
- We own the security of this code. Mitigations: small surface, well-known specs only, a mandatory security-review checklist on `auth/**` (CODEOWNERS), tests for every flow, and rate limits on all auth endpoints.
- Google sign-in needs the operator to create a Google OAuth client (free). Passkeys need nothing.
- Account recovery relies on a second passkey, a linked Google account, or a magic link.

## Alternatives considered
- **Clerk / Auth0 / WorkOS**: fastest to start, but a vendor dependency, cost, and data processor.
- **Passwords + bcrypt**: weakest user experience and security; never stored by us.
- **JWT sessions**: revocation is hard, and they bring no benefit given per-request DB authz.
