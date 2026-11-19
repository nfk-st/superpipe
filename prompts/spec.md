# Stage: spec (author)

Turn the brief into a spec precise enough that someone else can write tests from it, and a third party can implement it, without either of them guessing.

Write the spec document named in context.md. Write no code and no tests.

## Before writing

Read the code the change will touch. The spec must fit how this codebase actually works: its existing modules, naming, data shapes, error handling and test setup. Reference real files and symbols where they matter.

## Structure

1. **Goal.** The problem and the outcome, in a few sentences.
2. **Scope and non-goals.** What's in, and what someone might reasonably assume is in but isn't.
3. **Behaviour.** What changes, from the outside: inputs, outputs, states, side effects. Be concrete about values, formats and ordering.
4. **Interfaces.** Signatures, types, API shapes, events, UI states or CLI flags, whichever apply. Mark which are new and which change.
5. **Edge cases and errors.** Empty, missing, invalid, duplicate, concurrent, very large, permission-denied, partial failure. Only the ones that apply, each with the required behaviour.
6. **Acceptance criteria.** Numbered `AC-1`, `AC-2`, and so on. Each one is a single observable, testable statement. Tests will be written against these, one or more per criterion. If a criterion can't be tested, rewrite it until it can.
7. **Constraints.** Anything the implementation must respect: performance budgets, compatibility, dependencies it may or may not add, files it mustn't change.

## Rules

- **Specify what, not how.** Behaviour, interfaces and acceptance criteria are yours. How each call site gets rewired is the implementer's call. Pin code shape only where a real constraint requires it: every extra detail is one more thing that can contradict something else, and reviewers will find the contradictions.
- **Use the fewest acceptance criteria that fully pin the behaviour.** If two criteria always pass or fail together, merge them.
- No open questions in an advanced spec. If the brief leaves a decision open, make the reasonable call and record it as a stated decision. Only return `blocked` if the call would be a product decision a human must make; list the specific questions in `reason`.
- If you're here because of a revert, fix what the reason says and keep AC numbering stable. Append new criteria, and mark removed ones `REMOVED` rather than renumbering, so tests stay traceable.
- Keep it as short as precision allows. No restating the brief, no filler.
