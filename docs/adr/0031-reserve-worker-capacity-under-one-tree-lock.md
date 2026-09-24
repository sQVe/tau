# ADR 0031: Reserve worker capacity under one tree lock

- Status: Superseded by [ADR 0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md), including
  holding capacity after unconfirmed cleanup
- Date: 2026-09-17

## Context

Nested workers and root workers can request capacity from different processes. Counting records
before publishing a new task permits concurrent callers to exceed the cap. Waiting workers still
consume resources. Parent exit does not prove that their work stopped. Custom profiles and
environment values must not grant authority that their parent did not hold.

## Options considered

- Count published tasks without exclusion. Concurrent callers can both admit the last slot.
- Run a separate admission service. This adds a service lifetime beyond the required parent-owned
  control.
- Use one filesystem lock per root tree with durable reservations. This coordinates cooperating
  processes on Linux and macOS without another service.

## Decision

Reserve capacity under one root-tree filesystem lock. Keep the transaction synchronous, without
harness calls. Contention and full capacity return distinct refusals, not queued work.

Save the root cap once. Keep reservations immutable and derive release from matching, confirmed
parent cleanup. A report, idle turn, missing owner, or expired timestamp cannot release capacity.
Never reclaim a lock or uncertain reservation by age. Manual recovery must establish that the
relevant controllers and work stopped.

Keep admission independent of the harness. The Pi binding checks native lineage and parent-recorded
process identity. Environment variables locate records or configure the initial root cap; they do
not establish worker identity or override saved authority.

Nested work inherits exact model, provider, safety integration, and tools. Role instructions may add
guidance within the parent-assigned scope, but cannot replace that scope. Preserve legacy loadouts
rather than silently grant them new tools. Reject model overrides rather than resolve a new
provider, so nested work retains the parent's runtime authority.

Keep waiting parents reserved. Bound child deadlines before the parent's cleanup budget using the
shared monotonic clock. Child notices can wake a waiting parent, but cannot answer its pending
clarification. Unconfirmed cleanup remains in the handover and capacity accounting.

### Source adaptation

Adapt spawn-time restrictions, running-child settlement, and their test cases from
[pi-interactive-subagents at c3e8b53](https://github.com/amosblomqvist/pi-interactive-subagents/tree/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7).
Replace environment-based profile allowlists and process-local counts with checked saved authority
and atomic tree admission. Do not port restricted tool classes, self-spawn bans, or tmux control.

## Tradeoffs

- Concurrent cooperating processes share one cap without a detached supervisor.
- Duplicate receipts cannot decrement capacity twice or free another task's reservation.
- Cost: crashes can leave locks or reservations that require manual inspection.
- Cost: unresolved legacy work can block admission when its tree cannot be established. Confirmed
  stopped legacy work needs no ancestry reconstruction for capacity accounting.
- Cost: fully permitted workers can edit records directly. This is not adversarial storage or
  containment of arbitrary manually spawned processes.
- Cost: deadlines and cleanup remain parent-scoped. Recovery does not imply enforcement after parent
  exit.

## See also

- [ADR 0028: Keep worker control in the parent](./0028-keep-worker-control-in-the-parent.md)
- [ADR 0029: Version worker provider fingerprints](./0029-version-worker-provider-fingerprints.md)
- [ADR 0030: Claim native follow-ups before opening](./0030-claim-native-follow-ups-before-opening.md)
