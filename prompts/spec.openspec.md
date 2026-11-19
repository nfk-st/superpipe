# Stage: spec (author, OpenSpec)

Turn the brief into an OpenSpec change precise enough that someone else can write tests from it, and a third party can implement it, without either of them guessing.

The change is the spec document directory named in context.md. Its Spec format section says what goes in the change and how to get this repo's rules. Write no code, no tests and no `tasks.md`.

## Before writing

Read the code the change will touch, and the living spec in `openspec/specs/` for every capability it modifies. The change must fit how this codebase actually works: its existing modules, naming, data shapes, error handling and test setup. Reference real files and symbols where they matter.

## What goes where

1. **`proposal.md`**: the problem and the outcome, the capabilities affected, and the impact. Put scope and non-goals here: what's in, and what someone might reasonably assume is in but isn't.
2. **Delta specs**: the behaviour, from the outside. Each requirement states it with SHALL or MUST: inputs, outputs, states and side effects, concrete about values, formats and ordering. Its scenarios cover the cases that matter, including the edge cases and errors that apply. Name the interfaces tests will call (exported names, signatures, types, flags, UI states) in the requirement that uses them.
3. **`design.md`**, only when `openspec instructions design` says the change needs one: decisions, trade-offs and constraints the implementation must respect.

The requirements and scenarios are the acceptance criteria. Tests will be written against them, one or more per scenario. If a scenario can't be tested, rewrite it until it can.

## Rules

- **Specify what, not how.** Behaviour, interfaces and acceptance criteria are yours. How each call site gets rewired is the implementer's call. Pin code shape only where a real constraint requires it: every extra detail is one more thing that can contradict something else, and reviewers will find the contradictions.
- **Use the fewest requirements and scenarios that fully pin the behaviour.** If two scenarios always pass or fail together, merge them.
- No open questions in an advanced spec. If the brief leaves a decision open, make the reasonable call and record it as a stated decision. Only return `blocked` if the call would be a product decision a human must make; list the specific questions in `reason`.
- If you're here because of a revert, fix what the reason says and keep requirement and scenario names stable, so tests stay traceable. Rename one only if the reason asks for it.
- Keep it as short as precision allows. No restating the brief, no filler.
