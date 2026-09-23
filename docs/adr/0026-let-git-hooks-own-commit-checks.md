# ADR 0026: Let Git hooks own commit checks

- Status: Accepted
- Date: 2026-09-15
- Amended by: [ADR 0038](./0038-block-commits-only-on-verified-comment-inaccuracies.md)

## Context

Git hooks already express repository commit policy. Undoing successful hook rewrites made formatter
hooks require another commit call. Unlimited comment-review retries could repeat findings without
progress.

## Options considered

- Reject hook rewrites to preserve the reviewed tree. This treats successful formatting as failure
  and requires changing history after Git succeeds.
- Accept hook changes and report them. This preserves Git's result without a second check policy.
- Leave review retries unlimited. This allows corrections but risks automatic loops.

## Decision

Let installed Git hooks own commit checks and the final content and message. Never bypass hooks, run
separate project or message checks, or read commit configuration from `tau.json`.

Keep and report successful hook rewrites and added paths, even if later reporting fails. Never undo
successful commits. Stop the batch when a group has no staged changes, rather than invoking hooks on
an empty candidate.

On hook failure, unstage only requested paths and return raw output, preserving it if cleanup also
fails. Leave staging untouched if HEAD changed. Treat staging of requested paths during hooks as
hook-owned: index snapshots cannot distinguish hook writes from concurrent writes to the same paths.

Review the staged tree before hooks. Allow two automatic returns per review group; refuse further
retries if the next review still blocks. Evidence alone cannot reopen a refused tree, but corrected
trees remain reviewable. Scope groups to the working directory, base HEAD, and requested paths: a
changed base needs a fresh review. Review failures do not reset the limit. Findings cannot be
waived; missing-comment suggestions remain advisory.

This supersedes [ADR 0015](./0015-explicit-repository-commit-commands.md),
[ADR 0018](./0018-staged-message-and-hook-policy.md), and
[ADR 0020](./0020-checks-in-the-existing-checkout.md). Their check machinery was already removed by
[ADR 0025](./0025-use-git-hooks-without-preparation.md). Only that ADR's hook-rewrite restrictions
and deferred review limits change; its staging and preparation-removal decisions remain in force.

## Tradeoffs

- Repository owners maintain one check policy for Tau and human commits.
- Successful hook changes stay committed; bounded review retries prevent automatic loops.
- Cost: trusted hooks can commit unreviewed changes, including paths the request denylist would
  reject.
- Cost: hooks see unrelated working edits. Concurrent staging of the same requested paths is
  unsupported.
- Cost: review limits are session-local and bounded, not restrictions on manual Git use or new
  sessions.
