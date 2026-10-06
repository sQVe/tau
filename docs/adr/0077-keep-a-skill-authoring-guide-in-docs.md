# ADR 0077: Keep a skill authoring guide in docs

**Date**: 2026-10-01\
**Status**: Accepted

## Context

Skill reviews keep finding the same problems: writes before approval, stale evidence, inputs with no
steps, wrong command assumptions, and skills that grow with each fix. Rejected structure returns,
such as `## See also` sections and ADR links in skills.

[ADR 0004](./0004-skill-authoring-style.md) records the skill format, but an author needs a
checklist to apply while writing. [ADR 0010](./0010-documentation-scope.md) limits `docs/` to the
vision, the development guide, and the ADRs.

## Decision

`docs/` also holds `skill-authoring.md`, a guide with a checklist for skill authors, and
`skill-template.md`, a fill-in `SKILL.md`. This amends the list of what `docs/` holds in ADR 0010.
Keeping the guide and template next to the development guide lets authors and reviewers find them
where contributor guides live.

### Guide rules

- The guide covers decisions an author makes. It does not explain how any skill or feature works.
- A test over `skills/*/SKILL.md` enforces the mechanical rules: valid frontmatter, working local
  links, only the allowed headings, no ADR mentions, one command per shell block, and no
  `## See also` sections.
- The template stays outside `skills/`, so Pi never loads it as a skill.

## Consequences

### Positive

- Authors check their skill against the problems reviews found before review.
- The test catches rejected structure before review does.

### Negative

- The guide must stay short, or it grows like the skills it is meant to keep short.
- Most of the checklist is judgment that no test enforces.

## Alternatives considered

### Checklist in ADR 0004

Add the checklist to ADR 0004. Rejected because an ADR records a decision and does not change in
place, but the checklist will change as reviews find new problems.

### Guide as a skill

Ship the guide as a skill. Rejected because Pi would add it to every session, even when nobody
writes a skill.
