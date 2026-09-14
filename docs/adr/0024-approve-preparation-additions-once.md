# ADR 0024: Approve preparation-added files with the commit

- Status: Proposed
- Date: 2026-09-14

## Context

[ADR 0017](./0017-preparation-addition-assignment.md) separates assignment of preparation-added
files from commit approval. Users must choose whether generated files belong before seeing their
diff, then approve the complete commit after checks and review. File names alone do not explain
whether the changes belong together.

## Options considered

- Keep separate assignment and approval. Preserves an early scope decision, but asks users to decide
  without the diff and then approve the same files again.
- Include clean preparation-added files in the candidate and approve them with the commit. Gives
  users the diff, checks, and review before they decide whether to commit those files.

## Decision

Approve preparation-added files as part of the complete commit, not through a separate assignment
prompt. Including a file in the candidate permits checks and review, not a commit. The final
approval must identify added files and offer their staged diff.

Keep the existing ownership and sensitive-path checks as the eligibility rules. Unrelated dirty or
untracked work and paths owned by another group remain excluded. Keep the concurrent-write and
recovery guards. Prepared groups still require separate approvals; accepting one group does not
authorize later groups.

Startup preapproval still stops on any addition. No human sees the diff in that mode, so the caller
must inspect the files and list them explicitly in a new call.

This supersedes [ADR 0017](./0017-preparation-addition-assignment.md) and replaces the
additional-file assignment requirement in [ADR 0016](./0016-staged-preparation-ownership.md).
Separate staging and recovery remain unchanged.

## Tradeoffs

- Users decide once, with the complete candidate and its review available.
- Cost: checks and review may run on generated files the user later declines to commit.
- Cost: startup-preapproved calls still need a new call when preparation adds files.
