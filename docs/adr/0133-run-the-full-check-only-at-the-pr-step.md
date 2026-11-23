# ADR 0133: Run the full check at the PR step

**Date**: 2026-10-26\
**Status**: Accepted\
**Related**: [ADR 0105 (Queue full checks per checkout and reuse checks by identity)](./0105-queue-full-checks-per-repository-and-reuse-passing-logs.md),
[ADR 0150 (Defer one assignment's passing full check to a named owner)](./0150-defer-one-assignments-full-check-to-a-named-owner.md)

## Context

Workers, the `tdd` skill, and the `fix-bug` skill each ran the repository's full check. The same
suite then ran again at the PR step. Full checks of one repository run one at a time, so a run in a
worker makes other checkouts wait for the same lock. Over 14 days in October 2026, workers made 444
of 1,313 full check calls. In 37 passing runs, a worker and then its manager checked the same
content.

## Decision

The PR step runs the full check that gates publication. An editing worker may also run `full_check`,
because its success report needs a passing record for the tree it reports when the repository
configures a full check. One assignment may defer that passing record to a named owner
([ADR 0150](./0150-defer-one-assignments-full-check-to-a-named-owner.md)); the worker still runs the
check and cites the record, which may fail. A text rule alone did not stop a lead from accepting a
failing tree.

No skill tells a worker to run the full check. Workers verify with focused tests and the check stage
that failed. The `pr` skill keeps the `full_check` tool for the manager. An investigation worker's
tool list drops `full_check` even when its profile lists the tool or it loads the `pr` skill.

## Consequences

### Positive

- An editing worker's report can prove that its final tree passed the full suite.
- Investigation workers do not queue on the per-repository full check lock.

### Negative

- An editing worker can queue on the per-repository full check lock.
- The PR step can run the full suite again on a tree an editing worker already checked.

## Alternatives considered

### Keep the full check in every worker

Let every worker run the full check before it reports. Rejected because investigation workers add
lock waits without a report that needs the record, and the PR step would run the same suite on the
same work state, which [ADR 0105](./0105-queue-full-checks-per-repository-and-reuse-passing-logs.md)
rejected.

### Remove the tool only from the skills

Keep `full_check` in the worker profile and drop it from the `tdd` and `fix-bug` skills. Rejected
because the profile lists the tool directly, so workers would still get it.
