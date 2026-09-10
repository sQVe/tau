# ADR 0011: Shared TDD state

- Status: Proposed
- Date: 2026-09-10

## Context

Several Pi sessions can use one worktree. An evidence cache can retain permission after another
session turns the gate on. A stale writer can also erase another session's evidence or gate switch.

## Options considered

- Keep per-session caches. They cannot reliably reflect changes from other processes.
- Use only an in-process queue. It cannot protect state shared by separate Pi processes.
- Read disk state for each decision and lock read-modify-write operations across processes. This
  keeps one source of truth without adding a database or lock service.

## Decision

Use disk state as the source of truth. Use the canonical worktree path for state and evidence.
Permission and status use the same gate-off conditions. Protected paths remain blocked.

Use an exclusive directory lock for state updates. Run tests outside the lock so gate switches can
finish during long runs. Load the latest state and check test inputs after acquiring the lock.
Publish a complete snapshot by atomic rename from a unique temporary directory.

Bound lock waits and report failures. Never remove a lock because of its age: the owner may be
paused rather than dead. Recovery from an abandoned lock requires stopping other Tau sessions before
removing it. Reject symlinked state paths.

## Tradeoffs

- Sessions no longer retain stale permission or overwrite unrelated state from another session.
- Reads do not write evidence or wait for a state lock.
- A process crash can leave a lock that needs manual removal.
- All writers must use the locking protocol. Older Tau processes must be restarted before sharing
  the worktree with updated processes.
- The file-tool guard still cannot prevent changes made through bash or external programs.

## See also

- [ADR 0001: Application structure](./0001-application-structure.md)
- [ADR 0010: Documentation scope](./0010-documentation-scope.md)
