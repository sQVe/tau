# ADR 0088: Write skills in Markdown, with a guide, tools, and templates

**Date**: 2026-10-05\
**Status**: Accepted\
**Supersedes**: [ADR 0004 (Skill authoring style)](./README.md#retired),
[ADR 0077 (Keep a skill authoring guide in docs)](./README.md#retired), and the skill and tool split
in
[ADR 0083 (Turn on skill tools when the skill runs, and confirm outside writes)](./README.md#retired)\
**Related**:
[Skill authoring guide](../skill-authoring.md),
[ADR 0010 (Documentation scope)](./0010-documentation-scope.md)

## Context

Pi loads Tau skills from `src/skills/`. Pi implements the Agent Skills standard and allows any
structure in a skill body, so Tau must set its own shared rules. Without them, some skills read like
prose and others like command instructions. Vague descriptions also make it harder for Pi to choose
a skill.

Some skills sent the model to repository documents instead of stating the rule a step needs. The
model then had to leave the step to find the rule.

Shell in a skill has no tests, and each copy drifts on its own. A body or preview shape written
inline mixes the shape the user sees with the steps that produce it.

## Decision

Write Tau skills as Markdown in Pi's skill format. A skill states the rules its steps need. Command
mechanics move into tested tools, and output shapes move into templates next to the skill. The skill
keeps only judgment and order.

### Format

- Each skill is `src/skills/<skill-name>/SKILL.md`, with valid Agent Skills frontmatter. The `name`
  matches the directory, and the `description` says what the skill does and when to use it.
- The body uses normal Markdown headings. Tau uses no XML-like section tags, because Pi's format
  does not include them.

### Body structure

- A body uses only these `##` headings: `When to use`, `Goal`, `Hard rules`, `Procedure`, and
  `Checklist`. Not every skill needs every section.
- Skills have no `## See also` section.
- Until those skills change, `tests/skillFiles.test.ts` lists these exceptions by name: a `Replies`
  heading in `pr-feedback`, a `Changes after the start` heading in `start-slice`, and one
  multi-command shell block in `handover`. An entry is removed when its skill changes, and no entry
  is added.

### Authoring guide and template

- `docs/skill-authoring.md` is a checklist for skill authors. It also covers the tools a skill
  calls. It stays in `docs/`, so Pi does not load it into every session.
- `docs/skill-template.md` is a fill-in `SKILL.md`. It stays outside `src/skills/`, so Pi never
  loads it as a skill.
- An author copies the template, fills it in, and checks the skill against the guide. The guide
  covers decisions an author makes. It does not explain how a feature works.

### Division of responsibility

- A skill states each rule a step needs in a sentence the model can act on.
- A skill never links to, names, or cites an ADR. ADRs hold the reasons, and the skill holds the
  rule.
- A skill links its tool or template at the step that uses it.
- The tool description says when to call each action, its inputs, and the result fields a caller
  acts on. Errors name their own cause. The skill says when to call the tool and what to do with the
  result, and does not repeat the description.
- Skill judgment, such as order, approvals, and boundaries, stays apart from tool contracts and
  errors. The guide's table says where each kind of instruction goes.

### Growth path

- Keep `SKILL.md` as the entry point. When a skill outgrows one file, move details into nearby
  reference files, and link to them with relative links.
- Move command mechanics, JSON fields, parsing, and retry handling into a tested Tau tool. Move the
  shape of a body or preview the user sees into a template next to the skill.
- Do not add scripts to a skill. A step may give one command with its arguments. A shell block with
  several commands, conditions, or safety checks becomes a tool.

## Consequences

### Positive

- Tau skills match Pi's format, and clear descriptions help Pi choose the right skill.
- Tests cover command mechanics instead of untested shell in skills.
- Skills read as judgment and steps, and templates show the output shape in one place.
- The model reads each rule where it acts on it.

### Negative

- A rule that changes must be updated in every skill that states it.
- A new tool takes more work than a shell block in the skill.
- A skill that needs advice outside the five headings must fit it into `Hard rules` or a step.
- Contributors used to Claude Code may expect custom tags, and authors must learn the Markdown
  section names.
- The guide must stay short, or it grows like the skills it keeps short.
- Most of the checklist is judgment that no test enforces.

## Alternatives considered

### Author's choice of format

Let each author choose the format. Rejected because, although it allows more freedom, it makes
skills less consistent.

### XML-like tags

Use XML-like tags such as `<skill_overview>` and `<critical_rules>`. Rejected because, although they
are familiar from Claude Code skills, they are not part of Pi's format.

### Rules only in ADRs

Keep rules only in ADRs and link to them from skills. Rejected because the model had to leave the
step to find the rule in a record written for maintainers, and the user kept removing those links.

### Checklist in an ADR

Put the authoring checklist in an ADR. Rejected because the checklist changes each time a review
finds a new problem, and an ADR states one decision.

### Guide as a skill

Ship the guide as a skill. Rejected because Pi would add it to every session, even when nobody
writes a skill.

### Shell blocks in the skills

Keep shell blocks in the skills. Rejected because they stay untested, and the copies drift.

### Earlier body structure

Allow a `## Principles` section and let large skills grow into scripts. Rejected because the test
and the skill authoring guide already reject both, so the ADR would contradict them.
