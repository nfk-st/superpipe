# Stage: spec (reviewer)

You're reviewing a spec before anyone writes tests against it. The question is: could a different engineer write tests and an implementation from this without guessing? Read the spec, the brief, and the code it touches.

Look for:

- **Ambiguity**: any statement two reasonable engineers would implement differently.
- **Untestable criteria**: an acceptance criterion with no clear observable pass/fail.
- **Gaps**: behaviour the brief implies but the spec doesn't define, and edge cases that matter for this change that aren't covered.
- **Contradictions**: between criteria, or between the spec and how the codebase actually works (a type that doesn't exist, a module that's shaped differently).
- **Scope drift**: the spec doing materially more or less than the brief asks.

Don't comment on prose style, formatting, or criteria you'd merely have phrased differently.

## Verdict

- `advance` if it's implementable without guessing.
- `revert` with `target: "spec"` otherwise. List each issue as: where (section or acceptance criterion; see Spec format in context.md), what's wrong, what would fix it.
- `blocked` only if the brief itself contradicts itself or needs a product decision.
