# ADR 0015: Preparation addition assignment

- Status: Proposed
- Date: 2026-09-10

## Context

[Staged preparation ownership](./0014-staged-preparation-ownership.md) requires explicit assignment
of generated paths. Stopping every call forces a retry even when all additions belong to the current
group. Startup preapproval and earlier batch approval cannot authorize undiscovered paths.

## Options considered

- Always stop for a new call. Safe, but interrupts interactive preparation.
- Absorb clean additions automatically. Clean state does not establish user intent.
- Ask for assignment before candidate review and approval. Keeps assignment explicit without
  repeating preparation.

## Decision

Interactive calls offer assignment of all clean additions to the current group through the existing
scrollable overlay. Decline or cancellation stops the group. Partial assignment requires a new call.
Dirty preexisting paths, other groups' paths, and paths rejected by existing guards remain blocked.

Assignment covers the displayed prepared state. Reject working or private-index changes while that
choice is open. Preserve staged-only output; stage generated working changes after acceptance.
Checks, comment review, and final approval cover the complete candidate. Assignment grants neither
commit approval nor a review waiver.

Reserve accepted paths for their group until the call ends, including after a skip. Display
requested and added paths separately. Prepared UI and results use repository-relative paths so
additions outside a nested invoking directory remain unambiguous. Escape control characters in file
views.

Startup preapproval stops on additions without UI. Keep speculative preparation and later-group
approve-all reuse disabled for configured preparation. Reuse reviews only through the existing
actual-candidate keys, not a predicted prepared tree. Keep the no-preparation path unchanged.

Retain the recovery and hook policy from ADR 0014. Unexpected shared staging after publication may
belong to another writer; do not reset it before ownership-checked cleanup.

## Tradeoffs

- Interactive additions need assignment and then separate candidate approval.
- Unattended additions still require inspection and a new explicit call.
- Prepared batches retain serial review latency rather than guessing future candidates.

## See also

- [Commit preapproval](./0011-commit-preapproval.md)
- [Documentation scope](./0010-documentation-scope.md)
