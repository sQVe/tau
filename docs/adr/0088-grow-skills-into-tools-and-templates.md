# ADR 0088: Grow skills into tools and templates

- Status: Accepted
- Date: 2026-10-05
- Supersedes: the body structure and growth path in [ADR 0004](./0004-skill-authoring-style.md)

## Context

- ADR 0004 allowed a `## Principles` section and let a large skill grow into scripts.
- `tests/skillFiles.test.ts` accepts only five body headings and rejects new shell blocks with more
  than one command.
- Shell in a skill has no tests, and each copy drifts on its own.
- A body or preview shape written inline in a skill mixes the shape the user sees with the steps
  that produce it.

## Options considered

- Keep ADR 0004's body structure and growth path. Rejected: the checks and the
  [skill authoring guide](../skill-authoring.md) already reject both, so the ADR would contradict
  them.
- Move command mechanics into tested Tau tools and body or preview shapes into template files.
  Chosen: tests cover the mechanics, and the skill keeps only judgment and order.

## Decision

A skill body uses only the sections it needs from a fixed set. A skill grows by moving mechanics
into tested tools and shapes into templates, not into scripts.

### Body structure

- A skill body uses only these `##` headings: `When to use`, `Goal`, `Hard rules`, `Procedure`, and
  `Checklist`. There is no `## Principles` section.
- Not every skill needs every section.
- Skills have no `## See also` section.

### Growth path

- Keep `SKILL.md` as the entry point.
- Move command mechanics, JSON fields, parsing, and retry handling into a tested Tau tool. The step
  that needs it names the tool.
- Move the shape of a body or preview the user sees into a template file next to the skill.
- A step may give one command with its arguments. A shell block with several commands, conditions,
  or safety checks becomes a tool instead.

## Tradeoffs

- Tests cover command mechanics that skills used to hold as shell.
- The skill reads as judgment and steps, and templates show the output shape in one place.
- Cost: a new tool takes more work than a shell block in the skill.
- Cost: a skill that needs advice outside the five headings must fit it into `Hard rules` or a step.

## See also

- [ADR 0004: Skill authoring style](./0004-skill-authoring-style.md)
- [Skill authoring guide](../skill-authoring.md)
- [Tool authoring guide](../tool-authoring.md)
