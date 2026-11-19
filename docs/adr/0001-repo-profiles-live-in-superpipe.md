---
status: superseded by ADR-0002
---

# Repo profiles live in superpipe, never in the repo

superpipe is optional for a team: an operator can try it a few times, drop it, and be left with nothing to tidy up. So a repo's profile lives in superpipe and is matched to the repo by its `origin` remote, and nothing superpipe-specific is committed to the repo. Repo knowledge that every agent needs goes in the repo's own `AGENTS.md` instead, where it also serves people and agents outside the pipeline.

## Considered Options

- **A committed `.pipeline/config.json` in each repo**, the way most tools are configured and the way superpipe's first repo ran. Rejected: it puts superpipe into every teammate's checkout whether or not they use it, and a committed config overrode the operator's lineup. The mode is retired.
- **Each operator keeps their own profiles.** Rejected: teammates' copies of the same repo's facts drift apart.

## Consequences

- Only superpipe's maintainer edits team profiles. An operator's personal profile for the same repo wins outright, so they can unblock themselves without waiting.
- A profile can't set what the operator owns: the lineup, gates, limits and timeouts.
