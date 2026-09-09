# ADR 0010: Documentation scope

- Status: Accepted
- Date: 2026-09-09

## Context

- `docs/` held pages for some features, such as comment review and prompt snippets, plus a "Current
  status" section in the development guide that described every extension.
- Those pages restated what the code already decides: input limits, cache sizes, key bindings, and
  tool behavior. Each feature change had to be applied in two places.
- Nothing said when a feature needed a page, so some features had one and others had none.
- Code shows what a feature does, but not always why it was designed that way. Tau already records
  those reasons in ADRs.

## Options considered

- Keep a page per feature under `docs/`. Gives readers a guide, but duplicates behavior already
  defined in code and can drift as the code changes.
- Move each page next to the extension it describes. Shortens the distance, but still asks every
  feature change to update prose that repeats the code.
- Write no feature pages. Record decisions in ADRs, and let code and tool descriptions state
  behavior.

## Decision

Tau documents decisions, not features.

- ADRs record lasting decisions and their reasons, such as why Tau uses a particular file format or
  key binding. Include only the details needed to understand or follow the decision.
- Code states behavior. Tool and command descriptions state what the agent needs when it calls them.
- `docs/` holds only what no feature owns: the vision, the development guide, and the ADRs.
- Agent instructions stay beside the extension that loads them.

Do not add a page that explains how a feature works. Write an ADR when a lasting decision needs a
recorded reason.

An accepted ADR can define a current convention. Record a change to what a decision requires in a
new ADR that replaces it. Do not change the rules in place.

## Tradeoffs

- Fewer descriptions of behavior to keep in sync with code.
- Readers who want current behavior must read the code or tool descriptions.
- Cost: a reader who wants a guided tour of a feature does not get one.
- Cost: a decision recorded once is not updated as the feature grows, so an ADR describes the choice
  at the time it was made, not today's code.

## See also

- [ADR-0004: Skill authoring style](./0004-skill-authoring-style.md)
- [ADR-0006: Default writing policy](./0006-default-writing-policy.md)
