# ADR 0010: Documentation scope

**Date**: 2026-09-09\
**Status**: Accepted\
**Related**: [ADR 0004 (Skill authoring style)](./0004-skill-authoring-style.md),
[ADR 0006 (Load Tau's instruction sets into every prompt)](./0006-default-writing-policy.md),
[ADR 0077 (Keep a skill authoring guide in docs)](./0077-keep-a-skill-authoring-guide-in-docs.md)

## Context

Feature pages restated what the code already decides, such as input limits, cache sizes, key
bindings, and tool behavior. Each feature change had to be applied in two places, and nothing said
when a feature needed a page.

Code shows what a feature does, but not always why it was designed that way. Tau records those
reasons in ADRs.

ADRs that never change drift in their own way. When each rule change gets a new ADR that partly
supersedes the old one, chains form, and a reader must combine several files to find the current
rule.

## Decision

Tau documents decisions, not features. Tau writes no feature pages, because ADRs record decisions,
and code and tests state behavior.

### Where content lives

- ADRs record lasting decisions and their reasons, such as why Tau uses a particular file format or
  key binding. Include only the details needed to understand or follow the decision.
- Code and tests state behavior.
- `docs/` holds only what no feature owns: the vision, the development guide, the authoring guides,
  and the ADRs.
- The root README introduces the project and links to the rest. Topic details go in `docs/` and are
  linked from the documentation index.
- Agent instructions stay beside the extension that loads them.

### Adding and changing documents

Do not add a page that explains how a feature works. Write an ADR only for a choice with a lasting
reason and a credible alternative.

### Keeping ADRs current

- An ADR states the current decision. When its details change, edit the ADR in place.
- Supersede an ADR only when its core choice reverses. The new ADR then states the whole current
  rule, so a reader never has to combine two ADRs.
- The only status is Accepted. A retired ADR leaves the tree. The metadata is Date, Status, and at
  most one Supersedes line and one Related line.
- Do not write ticket IDs, benchmark tables, version numbers, or file lists that go stale. Name a
  file only when the decision is about that file.
- The [ADR index](./README.md) groups current ADRs by area and ends with a Retired table that gives
  each retired ADR's number, title, replacement, and last commit. Numbers are never reused.
- Git keeps the history. `git show <commit>:docs/adr/<file>` prints a retired ADR from its last
  commit.

## Consequences

### Positive

- Fewer descriptions of behavior to keep in sync with code.
- A reader finds the current form of a decision in one ADR.

### Negative

- Readers who want current behavior must read the code and tests.
- A reader who wants a guided tour of a feature does not get one.
- Every change to a decision must update its ADR in the same change, or the ADR drifts from the
  code.
- The reasoning behind an earlier version of a decision lives only in Git history.

## Alternatives considered

### A page per feature under `docs/`

Keep a page per feature under `docs/`. Rejected because, although it gives readers a guide, it
duplicates behavior already defined in code and can drift as the code changes.

### Pages next to each extension

Move each page next to the extension it describes. Rejected because, although it shortens the
distance, it still asks every feature change to update prose that repeats the code.

### A new ADR for every changed rule

Record each rule change in a new ADR that supersedes the old one, and leave the old ADR as written.
Rejected because it builds chains of partly superseded ADRs, and a reader must combine several files
to find the current rule.
