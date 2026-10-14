# ADR 0108: Make Linear writes on the user's own work without asking

**Date**: 2026-10-14\
**Status**: Accepted\
**Supersedes**: [ADR 0103 (Write slice flow Linear changes without approval)](./0103-write-slice-flow-linear-changes-without-approval.md)\
**Related**:
[ADR 0086 (Post to GitHub bots without a confirm)](./0086-post-to-github-bots-without-a-confirm.md),
[ADR 0100 (Let agents cancel Linear tickets after approval)](./0100-let-agents-cancel-linear-tickets-after-approval.md)

## Context

ADR 0103 listed the slice flow writes that need no approval. Other skills, ADRs, and guides kept
their own lists, and the lists disagreed. Agents asked before writes that no list named, such as a
finding comment on the ticket in progress or a fix ticket. A handover that told the receiver to
confirm every Linear write also overrode the skills, because the handover skill kept confirmation
for outward-facing actions.

Writes on the user's own work are seen first by the user. Only writes that other people read, or
that notify them, need a check before they go out.

## Decision

Agents make every Linear write on the user's own work without asking, and report each write with its
link afterwards. One list in the tracker skill holds this rule, and other skills and docs link to
it.

The rule and its ownership test live in the
[tracker skill's list](../../src/skills/tracker/SKILL.md#hard-rules). In short, writes on the user's
own work and replies to GitHub bots need no approval. Writes that other people see or that notify
them, and cancellations, ask first. Code-review posts without asking only when both its branch
ownership rule and the ticket rule find the work the user's own.

A handover does not add approval rules. The receiver's skills decide, and a handover tightens them
only when it quotes the user. A test reads every skill and fails when one grants "without asking"
for a write the list does not cover.

## Consequences

### Positive

- Review and audit findings reach the ticket without a prompt.
- One list changes in one place, and the test catches skills that drift.

### Negative

- A wrong ticket or comment reaches Linear before the user sees it. The user fixes it in Linear.
- A ticket with an unclear owner makes agents ask, because they treat it as another person's.

## Alternatives considered

### Keep the slice flow list

Keep ADR 0103 and add the missing writes to it. Rejected because the lists in four places kept
drifting, and the missing writes made agents ask.

### Let a handover tighten approval freely

Let the sender add approval rules to a handover. Rejected because workers treated a sender's line as
the user's instruction and let it override the skills.
