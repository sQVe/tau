# ADR 0150: Defer one assignment's passing full check to a named owner

**Date**: 2026-11-23\
**Status**: Accepted

## Context

An editing worker must report a passing `full_check` record for its final tree. Some assignments
change a tree that cannot pass by design. For example, a module can wait for a later assignment to
wire it in, while the build denies warnings about unused code. The worker then cannot report
`success`, even when its assigned work is complete. The parent has to accept the work without any
gate, and the expected check failure stays outside the report.

## Decision

An editing assignment may declare `fullCheck: { owner, reason }`. The declaration names who runs the
later passing check and why this tree cannot pass. The worker still runs `full_check` on its final
tree. Its `success` report is accepted when it cites the newest record for both the current tree and
the configured command, whether that record passed or failed. A newer record of another command does
not hide the matching record.

The declaration is a typed field on the launch and follow-up inputs, not a prose line in the task.
Tau parses it once at the boundary and saves it in the assignment record. Investigation profiles
refuse it because they do not run the check. Launch and follow-up also refuse it when the checkout
root configures no full check command, because the worker could not run the promised check. A
follow-up does not inherit it, because the new assignment needs its own reason to defer the check.

Without a declaration, the gate stays strict: the worker needs a passing record for the current tree
and command. A declared assignment that cites no record, or a record from another command, is
refused. So is a report that does not cite the record's log path. Running the check anyway shows the
parent every real failure, and the citation ties the accepted report to that record.

## Consequences

### Positive

- An intermediate assignment can report `success` without bypassing the gate.
- The report shows the expected check failure, its log, and the owner of the later passing check.
- A failure other than the declared one stays visible under Concerns.

### Negative

- Tau does not check that the named owner later passes the full check.
- The parent must declare the field again on each follow-up.
- The declaration needs a configured full check command in the repository.
- A declared assignment's gate accepts a failing record, so a reader must treat that record as
  evidence of the failure, not as proof that the tree is healthy.

## Alternatives considered

### Accept the report without a record or citation

Let a declared assignment report `success` with no full check at all. Rejected because an unexpected
failure would stay hidden, and the parent would have no log to inspect.

### Put the owner and reason in the task text

Ask the parent to write the declaration into the task. Rejected because a prose line needs a fragile
parse and gets no validation, so a missing or blank declaration would reach the worker.

### Keep the strict gate and let the parent accept the work by hand

Leave the gate unchanged and have the parent accept an incomplete report. Rejected because the
report then records no expected failure, no log, and no owner, and the gate no longer guards the
assignment.

### Link the owner to a later assignment

Resolve the owner to a saved assignment and require that assignment to pass before the first report
counts. Deferred because it couples two assignments across sessions, and the first use needs only a
named owner and a visible record.
