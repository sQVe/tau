# ADR 0014: Staged preparation ownership

- Status: Proposed
- Date: 2026-09-10

## Context

Preparation before staging cannot select the current group's changes. Preparation can also stage
unrequested paths or overwrite working data belonging to another group. Resetting requested paths to
HEAD loses prior staging. Restoring working files can overwrite concurrent user edits.

## Options considered

- Prepare in the shared index and restore a stash on failure. Stashes do not establish ownership,
  and restoring them can conflict with concurrent edits.
- Treat every prepared path as authorized. This absorbs unrelated changes without explicit
  assignment.
- Prepare with a private index, retain recovery data, and publish only an authorized candidate. This
  separates preparation staging from shared staging without changing HEAD or the stash stack.

## Decision

This replaces the preparation ordering and recovery choices in
[ADR 0013](./0013-explicit-repository-commit-commands.md). Keep its configuration contract and hook
policy.

Validate configuration before mutation. Prepare each staged group in a private index before checks,
review, and approval. Those decisions must cover the actual candidate, not an earlier version.

Preserve the original index and covered working data before preparation. Use a private recovery ref
to protect saved Git objects from garbage collection, without changing HEAD or the shared stash
stack.

Preparation does not grant permission to commit additional paths. Require explicit group assignment
and distinguish generated changes from prior user edits and other groups' files.

Restore only Tau-owned staging. On ownership conflicts, retain recovery data and report instructions
rather than overwrite concurrent changes. Never restore working files automatically.

## Tradeoffs

- Recovery needs storage proportional to covered data and can require manual inspection and removal.
- Unsupported states must fail before preparation rather than receive incomplete recovery coverage.
- Preparation runs cooperative repository commands. Recovery is not a sandbox and cannot protect
  against arbitrary writes outside its coverage.

## See also

- [ADR 0010: Documentation scope](./0010-documentation-scope.md)
- [ADR 0011: Commit preapproval at startup](./0011-commit-preapproval.md)
