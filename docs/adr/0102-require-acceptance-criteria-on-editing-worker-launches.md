# ADR 0102: Require acceptance criteria on editing worker launches

**Date**: 2026-10-12\
**Status**: Accepted\
**Related**: [ADR 0101 (Treat `.tau/` files as the working copy and trackers as the saved copy)](./0101-treat-tau-files-as-the-working-copy-and-trackers-as-the-saved-copy.md)

## Context

A manager briefs a worker with a goal, scope, files, and a way to know the work is done. The first
three help the worker, but a worker that is missing them can still ask or explore. Without a stated
way to know the work is done, a worker stops when it feels finished, and the manager and reviewer
have nothing concrete to check against.

Tool descriptions and manager guidelines can ask for a complete brief. Nothing enforces them, so a
rushed launch skips the part that is easiest to forget.

## Decision

Launches and follow-ups of editing roles require a list of acceptance criteria, and the tool refuses
a launch without one. Goal, scope, and files stay guidance in the tool description and the manager
guidelines.

Acceptance criteria get a code check because a missing criterion cannot be recovered later. A weak
goal or scope still gives the worker something to work from, and the manager can correct it when the
worker reports. A missing criterion leaves nothing to verify, so the review and the final report
have no target. The check is cheap: it tests that the list exists, not that the criteria are good.
Other brief items vary too much by task for a fixed rule, so a check on them would force filler.

The task record holds a working copy of the criteria. The agent ticket is the saved copy, as ADR
0101 says. The `start-slice` skill copies the ticket's `## Acceptance` items word for word into the
launch, so the worker and the reviewer see the same criteria the user approved. The reviewer maps
each criterion to evidence and reports one it cannot check as a finding.

## Consequences

### Positive

- Every editing worker has criteria that a manager and a reviewer can check.
- The criteria in the launch match the approved ticket.

### Negative

- A launch for small work must still write at least one criterion.
- The check cannot tell a good criterion from a vague one. The review finds vague ones.

## Alternatives considered

### Keep all brief items as guidance

Describe acceptance criteria in the tool description and trust the manager to follow it. Rejected
because a skipped criterion is not visible until review, and guidance has already failed to prevent
it.

### Check every brief item in code

Require goal, scope, and files as well. Rejected because these items change shape with the task, so
a required field would invite filler text that passes the check and helps nobody.
