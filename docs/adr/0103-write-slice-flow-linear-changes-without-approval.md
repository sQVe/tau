# ADR 0103: Write slice flow Linear changes without approval

**Date**: 2026-10-12\
**Status**: Superseded\
**Superseded by**:
[ADR 0108 (Make Linear writes on the user's own work without asking)](./0108-make-linear-writes-on-the-users-own-work-without-asking.md)\
**Related**:
[ADR 0075 (Plan work as PR-sized slices in Linear)](./0075-plan-work-as-pr-sized-slices-in-linear.md),
[ADR 0083 (Turn on skill tools when the skill runs, and confirm outside writes)](./0083-turn-on-skill-tools-when-the-skill-runs-and-confirm-outside-writes.md),
[ADR 0101 (Treat `.tau/` files as the working copy and trackers as the saved copy)](./0101-treat-tau-files-as-the-working-copy-and-trackers-as-the-saved-copy.md)

## Context

Every Linear write waits for the user to approve a preview. In the slice flow, one design leads to a
slice plan, a start per slice, and an audit comment per slice. Each of these asks for approval, and
the plan asks twice: once in the skill and once in the `slice` tool's confirm.

These writes follow from a design the user already agreed to in brainstorm. Each lands in a ticket
the flow owns, such as the container, a slice, or an agent ticket under it. The user reads the
result in the skill's report or in Linear, and approves these prompts by habit.

## Decision

Skills make the Linear writes of the slice flow without asking the user. The skill reports each
write with its identifier or link afterwards.

### Writes made without approval

- The finish-slice audit comment, added or updated.
- A slice start: moving the slice to In Progress, creating its agent tickets, and adding an agent
  ticket later inside the slice's outcome.
- A slice plan: creating or updating the container and slices, their `blocked-by` relations, and
  moving existing slices back into plan order.

### Writes that still need approval

- New tickets outside the slice flow, such as bugs, follow-ups, and human tickets.
- Relations added by hand, outside the `slice` tool.
- Cancellations.
- Any other Linear write the tracker skill makes.

### Checks that stay

Skills still write their drafts in `.tau/` and read Linear before they write. The duplicate, route,
and merge checks still run, and a problem they find still stops the write. The `slice` tool still
refuses a plan whose read state changed. GitHub writes keep their own previews and confirms.

## Consequences

### Positive

- A slice moves from plan to PR with no Linear prompt.
- The prompts that remain mark writes outside the planned flow, so the user reads them.

### Negative

- A wrong plan or a wrong agent ticket reaches Linear before the user sees it. The user fixes it in
  Linear or by running the skill again.
- An update can overwrite edits a person made in Linear to a planned ticket or the audit comment.
- The `slice` tool writes from any session, a worker included, because it no longer asks.

## Alternatives considered

### Keep the approvals

Keep a preview and confirm for each write. Rejected because the user approves these writes by habit,
and the prompts slow every slice.

### Keep an opt-in setting for the prompts

Let the user turn the old prompts back on. Rejected because it keeps two paths in every skill and in
the tool.
