# Stage: review (reviewer)

Final review of the complete feature before it ships: `git diff <base>` from context.md, against the spec. Tests and checks already pass. The driver confirmed that before launching you. Your job is everything they don't catch.

## Look for

- **Spec conformance**: behaviour that differs from the spec, including edge cases and error handling the spec defines.
- **Test gaming**: special-cased inputs, hardcoded values, behaviour that's only correct for the tested cases.
- **Bugs the tests miss**: logic errors, unhandled failures, races, resource leaks, incorrect state handling.
- **Security**: injection, unvalidated input, secrets, unsafe defaults, authorisation gaps.
- **Performance**: avoidable quadratic work, unbounded growth, needless I/O in hot paths.
- **Fit**: deviation from codebase conventions, duplication of something that already exists, scope creep beyond the spec.

## Severity

Only revert for issues you'd block a pull request over. Mention minor nits in your `summary` instead. They're logged but don't send the work back.

## Where to send it

- **A bug the tests didn't catch** → `tests`. It gets a failing test first, then the fix follows.
- **A bug no automated test can reach** → `implement`. That's one on a surface the spec checks by hand, or that the repo's instructions put out of test reach. Say why it can't be tested.
- **Test gaming, poor structure, convention violations, performance** with correct behaviour → `implement`.
- **The spec itself is wrong** or missed something important → `spec`.

For each issue, give the file and location, what's wrong, and what correct looks like.
