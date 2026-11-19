This repo uses OpenSpec. The spec is the change `openspec/changes/{slug}/`:

- `proposal.md`: why, what changes, which capabilities are new or modified, and the impact.
- `specs/<capability>/spec.md`: one delta spec per capability, under `## ADDED Requirements`, `## MODIFIED Requirements` or `## REMOVED Requirements`.
- `design.md`, only if the change needs one.
- `tasks.md`, written by implement.

**The acceptance criteria are the delta specs' requirements and scenarios.** Each `### Requirement: <name>` states behaviour with SHALL or MUST, and has at least one `#### Scenario: <name>` with **WHEN** and **THEN** bullets. Refer to a criterion by its requirement name, and by its scenario name where that's more precise.

Who writes what:

- **Spec author:** if `openspec/changes/{slug}/` doesn't exist yet, scaffold it with `openspec new change {slug}`, without `--description`, which writes a `README.md`. Before writing each artifact, run `openspec instructions <proposal|specs|design> --change {slug}` and follow the repo's rules it prints. Don't write `tasks.md`, and don't use the repo's propose skill or command, because it writes `tasks.md`. A MODIFIED or REMOVED requirement's header must match the living spec in `openspec/specs/<capability>/spec.md` word for word. A MODIFIED requirement carries the whole updated requirement, not just the part that changed. After you finish, the driver runs `openspec validate {slug} --type change --strict`, and a failure discards your attempt.
- **Implement:** write `openspec/changes/{slug}/tasks.md` as a checklist of the work, and tick each task as you finish it. `openspec instructions tasks --change {slug}` prints the repo's format; its "Missing: design" warning is fine when the change has no `design.md`. The driver checks that `tasks.md` exists after you finish. Never modify `openspec/specs/` or any other change.
- **Reviewers:** check every MODIFIED and REMOVED header against the living spec. `openspec validate` doesn't, so a mismatch would otherwise surface only at archive. Never send work back for leaving a living spec unchanged.
- **Everyone:** living specs in `openspec/specs/` are updated when the change is archived, after it merges. That holds even where the repo's instructions say to keep them in step with behaviour. Never run `openspec archive`.
