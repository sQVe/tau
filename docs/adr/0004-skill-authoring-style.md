# ADR 0004: Skill authoring style

- Status: Accepted
- Date: 2026-04-10

## Context

- Tau ships Pi skills from `skills/` at the package root but has no shared writing rules for them.
- Pi implements the Agent Skills standard and allows any structure in the SKILL.md body.
- Without shared rules:
  - some skills read like prose and others like command instructions.
  - contributors import Claude Code or Codex conventions Pi does not require.
  - skills duplicate repository rules instead of linking to them.
  - vague descriptions make it harder for Pi to choose a skill.

## Options considered

- Let each author choose the format. Allows more freedom but makes skills less consistent.
- Use XML-like tags such as `<skill_overview>` and `<critical_rules>`. Familiar from Claude Code
  skills, but not part of Pi's format.
- Use Markdown. Readable as plain text and matches Pi's format.

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
- `## See also` for linked rules or reference

Not every skill needs every section. Keep the structure easy to recognize.

### Division of responsibility

Skills explain how to do tasks. ADRs and code define the rules.

- put rules in ADRs or code that enforces them.
- link to the documents that define the rules instead of copying them.
- a skill may summarize the rules it needs. If they conflict, follow the linked document.

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
- Rules stay in one place.
- Cost: contributors used to Claude Code may expect custom tags.
- Cost: authors used to XML-like tags must learn the Markdown section names.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
- [ADR-0003: Externally observable identifiers](./0003-externally-observable-identifiers.md)
