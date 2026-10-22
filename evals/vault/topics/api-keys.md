---
type: topic
title: API keys
---

# API keys

Agents send `Authorization: Bearer sb_live_...`. Keys are stored as an HMAC with a server pepper,
can be limited to one project, and expire after 90 days by default.
