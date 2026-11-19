# ADR 0144: Remember Git probe answers within one operation

**Date**: 2026-11-19\
**Status**: Accepted

## Context

Tau asks Git whether a repository is bare and which object format it uses. Several reads and writes
ask the same question again and again. One pr evidence read started 124 to 271 Git processes. On a
loaded machine, the pr tests timed out at 5000 ms.

Git answers can change while the process runs, because a repository can be replaced at the same
path. A process-wide cache then keeps a stale answer. After a SHA-1 repository became SHA-256, Tau
kept hashing with SHA-1. After `core.bare` changed from true to false, Tau appended to a tracked
`.tau/.gitignore` that it had refused before.

## Decision

Tau remembers Git answers about a repository, its object format and whether it is bare, only within
one operation. A new operation asks Git again.

Operation scopes sit at top-level reads and writes: `readPublicationEvidence`, the standalone `pr`
coverage read, the review capture entries in
`src/reviewCapture/{evidence,generation,pinnedCapture}.ts`, and each `.tau` directory write.

A failed probe is not remembered, so the next call asks again. Only an answer keeps its place.

`src/git.ts` owns the mechanism: `withOperationProbes`, `readProbe`, and `operationProbeCache`.

## Consequences

### Positive

- One operation asks each question once. The five ME-1611 tests start 103, 159, 158, 138, and 219
  Git processes, down from 124, 197, 196, 168, and 271.
- A replaced repository is read with its new format on the next operation.
- A failed probe is retried on the next call instead of failing the whole operation.

### Negative

- Tau starts a few more Git processes than a process-wide cache would.
- A new top-level read or write that asks Git these questions must run in an operation scope.
  Outside a scope, each call asks Git again.

## Alternatives considered

### No cache

Ask Git on every check. Rejected because one pr evidence read started 124 to 271 Git processes, and
the pr tests timed out at 5000 ms on a loaded machine.

### A process-wide cache keyed by path

Keep each answer for the life of the process. Rejected because a repository replaced at the same
path keeps its old answer. Tau then hashed with SHA-1 after the repository became SHA-256, and
appended to a tracked `.tau/.gitignore` after `core.bare` changed from true to false.

### A process-wide cache plus a fresh check before each write

Check the repository again before each write and reuse the process-wide answer elsewhere. Rejected
because it adds a second code path that must stay in sync with the cache.
