# ADR 0030: Claim native follow-ups before opening

- Status: Proposed
- Date: 2026-09-17

## Context

Opening a Pi session can repair or migrate its file. Uncertain startup does not prove that the
session stayed unopened or that its worker stopped. Reusing a completed task's records would also
mix new work with its previous outcome and deadline.

## Options considered

- Restart the previous task and reset its deadline. This changes the meaning of accepted records and
  can repeat work after uncertain delivery.
- Reclaim abandoned continuation locks by age. Time alone cannot prove that a native writer stopped.
- Keep immutable task records and claim one successor before native opening. This separates new
  authority from old evidence and lets filesystem exclusion coordinate cooperating parents.

## Decision

Claim one successor per predecessor before opening the native session. Give each follow-up its own
task identity and parent-owned deadline. Preserve the native identity, original lineage, and saved
settings. Keep prior task and report records unchanged.

Require final handover and parent-confirmed stopped cleanup. Worker settlement alone does not prove
process exit. Refuse uncertain claims and prepared attempts without automatically retrying or
reclaiming them by age. A successor needs its own handover and stopped cleanup before another task
can follow it.

Read-only history may expose related tasks across the root-session tree. It does not transfer live
reply or cancellation ownership. An explicit follow-up creates new authority for its current parent.

## Tradeoffs

- Independent parents and processes cannot claim different successors for the same predecessor.
- New deadlines do not extend or reinterpret old tasks.
- Cost: failed preparation or startup can leave a conversation unavailable for automatic follow-up.
- Cost: bounded file inspection and live-writer checks are not a universal native-session lock.
  Manual Pi writers that bypass Tau can still race the handoff.
- Cost: native opening may perform Pi's own repair or migration after the claim succeeds.

## See also

- [ADR 0028: Keep worker control in the parent](./0028-keep-worker-control-in-the-parent.md)
- [ADR 0029: Version worker provider fingerprints](./0029-version-worker-provider-fingerprints.md)
