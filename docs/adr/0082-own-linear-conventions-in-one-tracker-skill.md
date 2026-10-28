# ADR 0082: Own Linear conventions in one tracker skill

**Date**: 2026-10-02\
**Status**: Accepted\
**Related**: [ADR 0075 (Plan work as PR-sized slices in Linear)](./0075-plan-work-as-pr-sized-slices-in-linear.md),
[ADR 0061 (Keep Tau config in a user file and a trusted repository file)](./0061-layer-tau-config-from-user-and-repository-files.md),
[ADR 0108 (Ask only before writes that other people see)](./0108-make-linear-writes-on-the-users-own-work-without-asking.md)

## Context

Agents write Linear tickets from several skills and from plain conversation. Only `slice` and
`start-slice` carried ticket rules, and each held a different part of them. A ticket written outside
those skills, such as a bug or a follow-up, followed no rules for its shape, team, or status.

Tickets go to two places: human tickets to the repository's team and project, agent tickets to a
shared agent team. The config named only the agent team, so the human route came from asking each
time.

## Decision

One `tracker` skill owns how Tau writes to Linear. It holds the ticket types, templates, routing,
and `linear` commands. Other skills keep only their own logic and follow it at each step that writes
a ticket, a relation, or a status. The rules then have one place to change, and any Linear write can
load them.

## Consequences

### Positive

- A bug or follow-up gets the same shape and route as a planned slice.
- Routing comes from config, so no skill asks the user for a team.

### Negative

- Every repository needs a config entry before an agent can write a human ticket for it.
- The prompt line prefixes are a contract between Tau and the skill, so changing one changes both.

## Alternatives considered

### Rules in each skill

Keep the rules in each skill that writes to Linear. Rejected because the copies drift, and writes
from other paths stay unruled.

### Workflow instructions

Put the rules in the workflow instructions. Rejected because every session would load Linear rules,
including sessions that never touch Linear.
