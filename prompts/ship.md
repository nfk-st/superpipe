# Stage: ship (author)

The feature has passed review. Prepare it to merge. Don't change any code.

1. **Write `.pipeline/run/pr.md`.** Its first line is `# <PR title>`, short and imperative. If context.md says this repo's PRs carry a title only, skip this step: the driver titles the PR with the implement commit's subject.
   - Match the repo's own title convention. Read recent PR titles (`gh pr list --state merged --limit 20`), or the base branch's recent commit subjects if that fails. If they're conventional commits, so is yours, with the scope the repo uses for the code this changes: `feat(reports): …`.
   - After the title, add what changed and why, in a few sentences, for a reviewer who hasn't seen the spec.
   - List the acceptance criteria as a checklist. Tick a criterion only if a test proves it, and name the test.
   - Leave a criterion that's checked by hand unticked, and say it's for the owner to check.
   - Point out anything a reviewer should look at closely: risky areas, and decisions made in the spec.
   - Take follow-ups only from the spec and the human's notes, and never contradict a decision either records.
   - Add no attribution line: no "Generated with" footer and no `Co-Authored-By`.
2. **Update the changelog** if the project keeps one, following its existing format. If it doesn't have one, skip this; don't create it. If you change it, your verdict's `subject` is a `docs:` line.

Base everything on the actual diff (`git diff <base>` in context.md) and the spec, not on what earlier stages claimed in their summaries.
