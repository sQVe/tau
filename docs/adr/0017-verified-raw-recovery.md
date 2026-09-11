# ADR 0017: Verified raw recovery

- Status: Accepted
- Date: 2026-09-10

## Context

Git objects do not preserve raw working bytes or basic permission modes. A saved index does not keep
staged-only objects reachable. Interrupted checkout changes need durable recovery data before any
working file can be displaced.

## Options considered

- Restore through a stash merge. Conflicts and concurrent staging make ownership unclear.
- Restore through Git checkout. Content conversion and Git's limited modes can lose original state.
- Save raw state and restore only an exact recognized state. Preserves covered data without guessing
  ownership, but requires manual recovery for ambiguous states.

## Decision

Reserve one pending recovery window exclusively. Sync and read back the original working snapshot,
exact index backup, HEAD identity, expected hidden state, and pending marker before authorizing
hiding. Use Git to create a self-contained pack rooted only at the saved index tree. Sync and verify
its pack and index without syncing unrelated history. Keep staged objects reachable through a
durable recovery ref. Commit calls reject any pending marker, including incomplete or malformed
state, before preparation, staging, or review.

Recovery takes exclusive ownership. It accepts either the complete original state or the complete
expected hidden state. Require unchanged HEAD and exact and logical index identity. This foundation
does not change or restore the shared index. Partial hiding, conflicting work, and interrupted
recovery require manual inspection rather than automatic merging or lock stealing.

Recheck each affected path and its parents around restoration. Keep full working snapshots at the
recovery boundaries, not per path. Sync displaced regular-file contents through the same validated
file descriptor used to read them. Retain displaced inodes, refuse publication collisions, and
verify restored data before clearing pending state. Keep archives and object refs after success,
including displaced files that open writers may still change.

Support local POSIX regular files, symlink targets, absence, and basic permission modes within the
existing 100 MiB working-data limit. Reject hardlinks, directory transitions, missing or unsafe
parents, external Git object storage, and unsupported indexes before authorizing hiding. Require an
existing HEAD and stopped writers. This is not protection against arbitrary concurrent writers,
ignored artifacts, external symlink targets, or filesystem failure despite successful sync calls.

Keep this foundation separate from preparation and candidate checks. It does not replace the
existing flow or introduce hiding, stashing, command discovery, or dependency installation.

## Tradeoffs

- Raw backups preserve data Git cannot represent, at the cost of additional storage and sync work.
- Conservative refusal can leave a pending marker even when no working files changed.
- Recovery archives need manual retention management. Automatic deletion could lose late writes
  through displaced file descriptors.

## See also

- [Staged preparation ownership](./0014-staged-preparation-ownership.md)
- [Documentation scope](./0010-documentation-scope.md)
