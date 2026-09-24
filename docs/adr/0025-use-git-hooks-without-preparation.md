# ADR 0025: Use Git hooks without preparation

- Status: Accepted; hook-rewrite restrictions and deferred review limits superseded by
  [ADR 0026](./0026-let-git-hooks-own-commit-checks.md); comment review removed by
  [ADR 0042](./0042-remove-commit-comment-review.md)
- Date: 2026-09-15

## Context

Tau's commit tool duplicates repository command execution and manages temporary staging, hidden
working edits, and recovery archives. Git hooks already provide a repository-owned place for commit
checks. Keeping Tau-run checks while removing recovery would require a temporary replacement for how
those checks see staged content.

## Options considered

- Remove preparation and recovery first, then remove Tau-run checks. This preserves the planned
  ticket sequence but adds temporary check behavior that the next change would delete.
- Remove preparation, recovery, and Tau-run checks together. Use the real index and let installed
  Git hooks run checks without a second Tau-specific configuration.

## Decision

Use installed Git hooks instead of Tau-owned preparation and check commands. Stage requested files
directly on the real index. Do not copy or hide working files, create recovery archives, or read
commit policy from `tau.json`.

Remove the old configuration without compatibility handling. Only the maintainers currently use Tau,
so these settings do not need a migration layer.

Keep comment review and existing staged-content, path, and message guards. Accepting hook rewrites
and changing review dispute limits are separate decisions.

This supersedes [ADR 0015](./0015-explicit-repository-commit-commands.md),
[ADR 0016](./0016-staged-preparation-ownership.md),
[ADR 0018](./0018-staged-message-and-hook-policy.md), [ADR 0019](./0019-verified-raw-recovery.md),
[ADR 0020](./0020-checks-in-the-existing-checkout.md), and
[ADR 0021](./0021-prune-verified-recovery.md). It also replaces the remaining preparation and check
rules in [ADR 0024](./0024-commit-without-human-approval.md), which already superseded
[ADR 0017](./0017-preparation-addition-assignment.md).

## Tradeoffs

- Repository owners maintain one commit-check path for Tau and human commits.
- Tau no longer needs backup and restoration rules for work it hides or changes before review.
- Cost: hooks see the current checkout, including unrelated working edits.
- Cost: formatting must happen before the call or through hooks. A hook that changes committed
  content still requires inspection and a new call under the retained guards.
