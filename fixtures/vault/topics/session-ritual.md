---
type: topic
title: Session ritual
aliases: [daily loop]
---

# Session ritual

## Start

Call `brain_context` with the project slug. It returns the goal, next steps, recent decisions and
the last sessions, trimmed to a token budget.

## End

Call `brain_save` with the session id: a summary, work done, next steps, decisions with rationale
and topic updates. It is one atomic commit.

## Check

Run `brain_check` now and then: unsaved sessions, stale projects, broken links, duplicate topics.
