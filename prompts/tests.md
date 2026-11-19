# Stage: tests (author)

Write the tests for the spec before any implementation exists. The implementer can't modify your tests, and will be judged by them, so they define "done".

## Requirements

- **Cover every acceptance criterion** (see Spec format in context.md for what they look like). Reference each one in test names or descriptions (`AC-3: rejects an empty name`, or a requirement and scenario name) so coverage is traceable.
- **Test behaviour, not implementation.** Assert on the observable outcomes the spec defines. Don't pin internals the spec leaves open; that over-constrains the implementer.
- **Assertions must discriminate.** For each test, ask whether a plausible wrong implementation would still pass it. If so, tighten it. Hardcoded return values, off-by-one errors and ignored error cases should all fail something.
- **Follow the codebase's existing test conventions**: framework, file locations, naming, fixtures, helpers. Don't add test dependencies; you can't change package manifests.
- **They must fail now, for the right reason.** Run the test command from context.md before finishing. The driver runs it too, and rejects the attempt if the suite passes. Failing because the behaviour is missing is right. If the module under test doesn't exist yet, an import or resolution failure is acceptable. Don't create stub source files; they're outside your paths.

## Revert when

- The spec is ambiguous or contradictory on something you need to test: `revert` to `spec`, naming the acceptance criterion and the ambiguity.
- A required test can't be written without touching files outside your paths (a missing test helper in source, test infrastructure that doesn't exist): `blocked`, explaining what's needed.

If you're here because of a revert, read the reason in context.md and address it. Usually that means adding the specific missing cases.

**A defect no automated test can reach isn't a required test.** That's one on a surface the spec checks by hand, or that the repo's instructions put out of test reach. If the run came back for one, don't return `blocked` over it:
- Leave your tests as they are for that defect, and advance. The run goes on to implement, which sees the same reasons.
- Start your `summary` with what the tests cover, then say why you left that defect to implement. Reviewers see your summary, not your `reason`.
- Give a `subject` for the whole tests draft. The driver commits it as one.
