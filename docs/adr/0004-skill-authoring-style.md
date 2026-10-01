# ADR 0004: Skill authoring style

- Status: Accepted
- Date: 2026-04-10

## Context

- Tau ships Pi skills from `skills/` at the package root but has no shared writing rules for them.
- Pi implements the Agent Skills standard and allows any structure in the SKILL.md body.
- Without shared rules:
  - some skills read like prose and others like command instructions.
  - contributors import Claude Code or Codex conventions Pi does not require.
  - skills send the model to repository documents instead of stating the rule a step needs.
  - vague descriptions make it harder for Pi to choose a skill.

## Options considered

- Let each author choose the format. Rejected: it allows more freedom but makes skills less
  consistent.
- Use XML-like tags such as `<skill_overview>` and `<critical_rules>`. Rejected: they are familiar
  from Claude Code skills, but not part of Pi's format.
- Use Markdown. Chosen: it reads well as plain text and matches Pi's format.

## Decision

Write Tau skills in Markdown using Pi's skill format.

### Required shape

Every skill must:

- live under `skills/<skill-name>/SKILL.md`.
- use valid Agent Skills frontmatter.
- keep `name` equal to the parent directory name.
- provide a specific `description` stating what the skill does and when to use it.
- use normal Markdown headings for the body.

Tau does not use custom XML-like section tags. Models may read them as plain text, but they are not
part of Pi's skill format.

### Body structure

Prefer this shape when applicable:

- `# <Skill Name>`
- `## When to use`
- `## Goal`
- `## Principles` or `## Hard rules`
- `## Procedure` for repeatable workflows
- `## Checklist` when a final review pass helps

Not every skill needs every section. Put each link inline at the step that needs it. Skills have no
`## See also` section. Keep the structure easy to recognize.

### Division of responsibility

Skills explain how to do tasks. ADRs record why a rule exists, for maintainers.

- state each rule a step needs in the skill, in a sentence the model can act on.
- never link to, name, or cite an ADR in a skill. An ADR explains a decision; the model needs the
  rule.
- put mechanical rules in code that enforces them, and link that tool or template at the step that
  uses it.

### Writing style

- Keep skills concise enough to scan.
- State when to use the skill.
- State which steps are required.
- Stay readable and editable as ordinary Markdown.

Use principles and checklists for advice. Use numbered steps for a procedure.

### Growth path

When a skill outgrows one file, keep `SKILL.md` as the entry point and move details into nearby
reference files, scripts, or other files. Use relative links so the agent can load them when needed.

## Tradeoffs

- Tau skills match Pi's format.
- Skills stay easy to read, review, and edit.
- Descriptions help Pi choose the right skill.
- The model reads each rule where it acts on it.
- Cost: a rule that changes must be updated in every skill that states it.
- Cost: contributors used to Claude Code may expect custom tags.
- Cost: authors used to XML-like tags must learn the Markdown section names.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
- [ADR-0003: Externally observable identifiers](./0003-externally-observable-identifiers.md)
