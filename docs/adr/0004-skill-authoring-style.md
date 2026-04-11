# ADR 0004: Skill authoring style

- Status: Approved
- Date: 2026-04-10

## Context

Tau ships Pi skills from `skills/` at the package root, but does not yet state how to write them. Pi
implements the Agent Skills standard and keeps the SKILL.md body freeform. Without a house style,
skills drift:

- one reads like prose, another like a command protocol.
- contributors import Claude Code or Codex conventions Pi does not require.
- skills duplicate repository policy instead of linking to it.
- descriptions become too vague for reliable auto-loading.

## Options considered

- **No house style.** Each skill picks its own form. Maximizes author freedom; maximizes drift.
- **XML-like section tags** (`<skill_overview>`, `<critical_rules>`). Familiar from Claude Code
  skills, but not part of Pi's format.
- **Markdown-first house style.** Readable as plain Markdown, close to Pi's native model.

## Decision

Tau skills use a Pi-native, Markdown-first authoring style.

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
- `## See also` for linked policy or reference

Not every skill needs every section, but the structure should stay recognizable.

### Division of responsibility

Skills are guidance and workflow packages, not the source of repository truth.

- normative rules belong in policies, ADRs, or code enforcement.
- skills link to authoritative documents instead of restating large policy texts.
- a skill may summarize rules needed to operate correctly; on conflict, the linked policy wins.

### Writing style

- concise enough to scan.
- explicit about trigger conditions.
- specific about required behavior when the workflow is strict.
- readable and editable as ordinary Markdown.

Advisory skills use principles, heuristics, and checklists. Procedural skills use a step-by-step
procedure, not custom tagged sections.

### Growth path

When a skill outgrows one file, keep `SKILL.md` as the entry point and move detail into sibling
references, scripts, or assets loaded on demand through relative links.

## Tradeoffs

- - Tau skills match Pi's native model instead of importing conventions Pi does not require.
- - Skills stay easy to read, review, and edit.
- - Descriptions become more useful for Pi's on-demand loading.
- - Policy stays authoritative in one place instead of drifting across skills.
- − Contributors familiar with Claude Code style may expect richer custom markup.
- − Rigid workflows feel slightly less templated without XML-like tags.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
- [ADR-0003: Externally observable identifiers](./0003-externally-observable-identifiers.md)
