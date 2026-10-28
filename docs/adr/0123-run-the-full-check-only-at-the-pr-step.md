# ADR 0123: Run the full check only at the PR step

**Date**: 2026-10-26\
**Status**: Accepted\
**Related**: [ADR 0105 (Queue full checks per repository and reuse checks by identity)](./0105-queue-full-checks-per-repository-and-reuse-passing-logs.md)

## Context

Workers, the `tdd` skill, and the `fix-bug` skill each ran the repository's full check. The same
suite then ran again at the PR step. Full checks of one repository run one at a time, so a run in a
worker makes other checkouts wait for the same lock. Over 14 days in October 2026, workers made 444
of 1,313 full check calls. In 37 passing runs, a worker and then its manager checked the same
content.

## Decision

The PR step runs the only local full check. Workers have no `full_check` tool, and no skill tells a
worker to run the full check. Workers verify with focused tests and the check stage that failed. The
`pr` skill keeps the `full_check` tool for the manager. A worker's tool list drops `full_check` even
when its profile lists the tool or it loads the `pr` skill.

## Consequences

### Positive

- Each work state runs the full suite once, at the PR step.
- Workers do not queue on the per-repository full check lock.

### Negative

- A failure in the full suite appears at the PR step, after the worker has finished its change.
- A worker can miss a failure that only the full suite shows, until the PR step runs.

## Alternatives considered

### Keep the full check in workers

Let each worker run the full check before it reports. Rejected because the PR step would run the
same suite on the same work state, which
[ADR 0105](./0105-queue-full-checks-per-repository-and-reuse-passing-logs.md) rejected.

### Remove the tool only from the skills

Keep `full_check` in the worker profile and drop it from the `tdd` and `fix-bug` skills. Rejected
because the profile lists the tool directly, so workers would still get it.
