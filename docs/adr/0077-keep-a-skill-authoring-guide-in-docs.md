# ADR 0077: Keep a skill authoring guide in docs

- Status: Accepted
- Date: 2026-10-01

## Context

- Skill reviews keep finding the same problems: writes before approval, stale evidence, inputs with
  no steps, wrong command assumptions, and skills that grow with each fix.
- Rejected structure returns, such as `## See also` sections and ADR links in skills.
- [ADR 0004](./0004-skill-authoring-style.md) records the skill format, but an author needs a
  checklist to apply while writing.
- [ADR 0010](./0010-documentation-scope.md) limits `docs/` to the vision, the development guide, and
  the ADRs.

## Options considered

- Add the checklist to ADR 0004. Rejected: an ADR records a decision and does not change in place,
  but the checklist will change as reviews find new problems.
- Ship the guide as a skill. Rejected: Pi would add it to every session, even when nobody writes a
  skill.
- Keep a guide and a template in `docs/`, next to the development guide. Chosen: authors and
  reviewers find it where contributor guides live.

## Decision

`docs/` also holds `skill-authoring.md`, a guide with a checklist for skill authors, and
`skill-template.md`, a fill-in `SKILL.md`.

- The guide covers decisions an author makes. It does not explain how any skill or feature works.
- A test over `skills/*/SKILL.md` enforces the mechanical rules: frontmatter, local links, and no
  ADR references or `## See also` sections.
- The template stays outside `skills/`, so Pi never loads it as a skill.

## Tradeoffs

- Authors check their skill against the problems reviews found before review.
- The test catches rejected structure before review does.
- Cost: the guide must stay short, or it grows like the skills it is meant to keep short.
- Cost: most of the checklist is judgment that no test enforces.
