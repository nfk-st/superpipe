---
status: accepted
---

# Profiles are personal, shared by export and import

A profile names the team's private repos, their projects and their commands. So keeping profiles in superpipe would stop superpipe itself from ever being made public. Instead, each operator keeps one profile per repo in their own `~/.superpipe/repos/`. `superpipe profile` has Claude Code write it with them and then checks it, and `export` and `import` hand a copy to a teammate. This supersedes ADR 0001.

## Considered Options

- **Team profiles in superpipe's `repos/` (ADR 0001).** Rejected: anyone who can read superpipe can read every team's repo facts.
- **A private repo of profiles that each operator clones into `~/.superpipe/repos/`.** Rejected: every teammate needs access granted to yet another repo, and nothing superpipe-specific goes into the team's GitHub organisation.

## Consequences

- Operators' copies of one repo's profile can drift apart, which ADR 0001 avoided. The fix is to export the corrected profile again.
- superpipe ships no team profiles, but still reads a `repos/` folder in its own checkout. A personal profile for the same repo still wins outright.
- Nothing superpipe-specific is committed to a repo, and a profile still can't set what the operator owns: the lineup, gates, limits and timeouts.
