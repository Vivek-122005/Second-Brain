# Product Vision

## One-liner

**Second Brain is a persistent memory layer that humans and AI assistants share.** Each agent starts a session knowing the current state of the work, and each session leaves the store a little smarter.

## What a "second brain" is

A second brain is an external, trusted system that holds what you know: projects, decisions, ideas and history. Because it is organised and linked, you can find things again and build on them, so your head is free to think.

Classic second-brain tools (Obsidian, Notion, Roam) are built for humans. The shift in 2025–26 is that **AI agents now do a large share of knowledge work**, and they are amnesiac. Second Brain gives both humans and agents the same memory:

- **Humans** write and curate notes in Markdown, from the web app or from Obsidian on the Git repository.
- **Agents** read context at session start, search during work, and write back decisions and session summaries at the end, through MCP.

## What it builds up over time

| Asset | Description |
|---|---|
| **Project state** | Goal, status and next steps for each project, always current |
| **Decision log** | Append-only record of *what was decided and why*, with supersession, so later decisions retire earlier ones |
| **Topic knowledge** | Long-lived notes on concepts, systems, people and vendors, linked with `[[wikilinks]]` into a graph |
| **Session history** | One log per working session: summary, work done, next steps |
| **Activity trail** (optional) | Raw tool-call history from agents, archived cheaply |

Together these become an organisational memory that compounds: the more you use it, the less any person or agent has to re-derive.

## Personas

| Persona | Situation | Job to be done |
|---|---|---|
| **P1: Solo builder (you)** | Uses 2–4 AI assistants across laptop, desktop and cloud sessions on several projects | "When I open any assistant, it should already know where I left off and what I decided." |
| **P2: Knowledge worker** | Research, writing, consulting | "Capture insights once and have them come back when relevant." |
| **P3: Small team lead** | 3–20 people plus their agents on shared projects | "My team's agents should work from the same decisions and status, not contradict each other." |
| **P4: Business / IT admin** | Buying an internal knowledge tool | "Give us SSO, role-based access, audit logs, data residency and export, and keep each team's data isolated." |

P1 is the design centre for v1, because it gets daily use and fast feedback. P3 and P4 shape the architecture from day one (tenancy, RBAC, audit), so we never have to re-platform.

## Key use cases

1. **Resume work**: "Continue the billing refactor." The agent calls `brain_context(project: "billing")` and gets status, the last three sessions and recent decisions.
2. **Record a decision**: "We'll use Postgres advisory locks instead of Redis." The decision is saved with its rationale and supersedes the older one.
3. **Ask the brain**: "What did we decide about rate limiting?" The agent runs a hybrid search and cites the notes it used.
4. **End of session**: the agent calls `brain_save`, which makes one atomic commit with the session log, decisions, topic updates and project `next` field.
5. **Hygiene**: a weekly `brain_check` reports stale projects, unsaved sessions, broken links and duplicate topics, and proposes fixes.
6. **Team share**: you share the `acme-website` project with a contractor as viewer. Their agent can read it only after they accept the share.
7. **Edit as a human**: open the vault in Obsidian, edit a note and push. The webhook re-indexes it within seconds.

## Product principles

1. **The user owns the data.** Plain Markdown in a Git repo the user controls, with no lock-in. The index is disposable.
2. **The ritual is the product.** Context → work → save → check. Make it fast, cheap in tokens, and automatic.
3. **Memory is data, never instructions.** Everything an agent reads from the brain is labelled untrusted.
4. **Context is scarce.** Every response has a token budget; we trim before the client has to.
5. **Secure by default, shareable by choice.** Private unless shared, consent before shared content reaches an agent, and audit everything.
6. **Boring, serverless operations.** No servers to patch, minimal running cost, everything rebuildable.

## Non-goals (v1)

- A general-purpose wiki or Notion replacement (no rich blocks, databases or real-time co-editing).
- End-to-end encryption of searchable content. It conflicts with server-side search; see [Security](../03-security/security.md#24-end-to-end-encryption).
- Our own LLM or chat UI. We are the memory layer, and clients bring the model.
- Mobile apps. The web app will be responsive; native apps come later.

## Business model (hypothesis)

| Tier | For | Includes |
|---|---|---|
| **Personal** (free / self-host) | P1, P2 | 1 user, personal space, keyword search, BYO Git repo |
| **Pro** | Power users | Semantic search, activity logging, more keys and storage |
| **Team** | P3 | Shared spaces, roles, invitations, team audit log |
| **Business** | P4 | SSO (OIDC/SAML), SCIM, data residency, retention policies, managed vault backend, SLA |

## Success metrics

- **Activation:** first `brain_context` → `brain_save` loop completed within 10 minutes of sign-up.
- **Daily use (P1):** at least 1 saved session per working day.
- **Context quality:** fewer than 10% of sessions where the user has to re-explain context (self-reported or sampled).
- **Performance:** p95 `brain_context` under 300 ms, p95 search under 200 ms.
- **Cost:** under $5/month infrastructure for a heavy single user.
