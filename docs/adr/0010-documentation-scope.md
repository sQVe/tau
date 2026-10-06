# ADR 0010: Documentation scope

**Date**: 2026-09-09\
**Status**: Accepted;
[ADR 0077 (Keep a skill authoring guide in docs)](./0077-keep-a-skill-authoring-guide-in-docs.md)
amends what `docs/` holds\
**Related**: [ADR 0004 (Skill authoring style)](./0004-skill-authoring-style.md),
[ADR 0006 (Default writing policy)](./0006-default-writing-policy.md)

## Context

`docs/` held pages for some features, such as comment review and prompt snippets, plus a "Current
status" section in the development guide that described every extension. Those pages restated what
the code already decides: input limits, cache sizes, key bindings, and tool behavior. Each feature
change had to be applied in two places.

Nothing said when a feature needed a page, so some features had one and others had none.

Code shows what a feature does, but not always why it was designed that way. Tau already records
those reasons in ADRs.

## Decision

Tau documents decisions, not features. Tau writes no feature pages, because ADRs record decisions,
and code and tool descriptions state behavior.

### Where content lives

- ADRs record lasting decisions and their reasons, such as why Tau uses a particular file format or
  key binding. Include only the details needed to understand or follow the decision.
- Code states behavior. Tool and command descriptions state what the agent needs when it calls them.
- `docs/` holds only what no feature owns: the vision, the development guide, and the ADRs.
- The root README introduces the project and links to the rest. Topic details go in `docs/` and are
  linked from the documentation index.
- Agent instructions stay beside the extension that loads them.

### Adding and changing documents

Do not add a page that explains how a feature works. Write an ADR when a lasting decision needs a
recorded reason.

An accepted ADR can define a current convention. Record a change to what a decision requires in a
new ADR that replaces it. Do not change the rules in place.

## Consequences

### Positive

- Fewer descriptions of behavior to keep in sync with code.

### Negative

- Readers who want current behavior must read the code or tool descriptions.
- A reader who wants a guided tour of a feature does not get one.
- A decision recorded once is not updated as the feature grows, so an ADR describes the choice at
  the time it was made, not today's code.

## Alternatives considered

### A page per feature under `docs/`

Keep a page per feature under `docs/`. Rejected because, although it gives readers a guide, it
duplicates behavior already defined in code and can drift as the code changes.

### Pages next to each extension

Move each page next to the extension it describes. Rejected because, although it shortens the
distance, it still asks every feature change to update prose that repeats the code.
