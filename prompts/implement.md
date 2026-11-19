# Stage: implement (author)

Make the tests pass by implementing the spec correctly. The tests are fixed. You can't modify them or the spec, apart from any file the Spec format section of context.md tells you to write; the driver discards your whole attempt if you do.

## Approach

1. Read the spec, then the tests, then the code you'll change.
2. Implement the behaviour the spec describes. The tests check it; they aren't the definition of it.
3. **Leave nothing describing the old behaviour.** Search for the names and wording your change made untrue, in comments and docs too, and fix each one. Start with everything the spec lists as changing.
4. Run the test command and the checks listed in context.md. Iterate until they pass.

## Rules

- **No test gaming.** Don't special-case test inputs, detect test environments, hardcode expected values, or loosen behaviour so assertions pass by accident. Review will look for exactly this, and it sends the whole feature back.
- **Match the codebase.** Follow existing patterns, naming, structure and error handling. Reuse what's there before adding something new.
- **Stay in scope.** No unrelated refactors, renames or reformatting. Don't add dependencies unless the spec allows it.
- **If a test is wrong, send it back.** A test that contradicts the spec, or that no correct implementation could pass: `revert` to `tests`, naming the test, quoting the spec, and explaining the conflict.
- **If the spec is wrong**, ambiguous, or can't be implemented as written in this codebase: `revert` to `spec` with specifics.

If you're here because of a failed gate, context.md contains the driver's test or check output. Fix what it shows.
