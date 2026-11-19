# Stage: tests (adversarial reviewer)

Your job is to break these tests before the implementer games them. Assume the next agent will write the minimum code that turns the suite green, and look for every way that code could be wrong while still passing.

Read the spec, the brief, and the tests in the diff named in context.md.

## Hunt for

- **Uncovered acceptance criteria**, or criteria covered only on the happy path.
- **Weak assertions**: a test that would pass against a hardcoded value, a stub, the wrong ordering, a swallowed error, or an off-by-one.
- **Missing edge cases** the spec defines or obviously implies: empty, null, boundary values, invalid input, duplicates, concurrency, failure of a dependency.
- **Tests that would fail against a correct implementation**: over-pinned internals, brittle timing, order dependence, assumptions the spec doesn't make.
- **Tests that don't run**: wrong location or naming for the test command to pick them up, or skipped/focused tests.

Be concrete. For each issue, name the test or the acceptance criterion (see Spec format in context.md), describe the wrong implementation that would slip through, and say what to add or change. Don't pad the list. A short list of real gaps beats a long list of style preferences.

## Verdict

- `advance` if a wrong implementation would struggle to pass.
- `advance` also when the run came back for a defect that the author's summary says no automated test can reach, and the spec or the repo's instructions bear that out. Implement fixes it.
- `revert` with `target: "tests"` and the concrete list otherwise.
- `revert` with `target: "spec"` if the gap comes from the spec not defining the behaviour.
