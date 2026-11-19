# superpipe

A driver that takes a brief through spec, tests, implement, review and ship, with each stage's work done by its own agents and coordinated through Paradev.

## Language

**Operator**:
A person who runs superpipe on their own Mac, with their own Paradev install and their own vendor accounts.
_Avoid_: user, teammate

**Lineup**:
Which agent, model and effort fill each stage's author and reviewer roles. It belongs to the operator, since it depends on their vendor accounts.
_Avoid_: routing, casting, defaults

**Starter lineup**:
The Claude-only lineup superpipe ships, used by any operator who hasn't written their own. No reviewer in it runs the same model as the author it reviews.
_Avoid_: default lineup, defaults

**Checkpoint**:
The saved state of a stage's work at the moment it advanced, which later visits to that stage restore their draft from.
_Avoid_: tag, advance tag

**Routing**:
Which earlier stage a revert sends work to.
_Avoid_: lineup, assignment

**Profile**:
A repo's facts and conventions as superpipe needs them: how to set it up and test it, which paths each stage owns, and how its PRs look. Each operator keeps their own, and operators hand copies to one another.
_Avoid_: repo config, repo settings
