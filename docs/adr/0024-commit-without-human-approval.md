# ADR 0024: Commit without human approval

**Date**: 2026-09-15\
**Status**: Accepted; preparation and check rules superseded by
[ADR 0025 (Use Git hooks without preparation)](./0025-use-git-hooks-without-preparation.md); comment
review removed by [ADR 0042 (Remove commit comment review)](./0042-remove-commit-comment-review.md)

## Context

Commit approval makes unattended workers depend on a startup flag and a person who can resolve
blocked screens. A terminal UI does not mean a person is present. Commit failures need to reach the
agent so it can correct the request or report the blocker.

## Decision

Commit without human approval in every mode. This gives interactive and unattended workers the same
error and retry path.

Remove the startup flag, approval overlay, message editor, and review waivers. Failed message checks
and blocking comment reviews return tool errors. Message corrections require a new call.

Preparation-added paths still require inspection and explicit assignment in a new call. Generated
output alone does not authorize adding files to a commit. Preparation, recovery, repository checks,
and post-commit safeguards remain in place.

This replaces [ADR 0011](./0011-commit-preapproval.md) and
[ADR 0017](./0017-preparation-addition-assignment.md). It also replaces the in-place message editing
rule in [ADR 0018](./0018-staged-message-and-hook-policy.md), not its check or hook policy.

## Consequences

### Positive

- Workers do not wait for commit approval or require a launcher flag.
- Blocking failures use one correction path in every mode.

### Negative

- Users no longer inspect or edit a commit in a final approval screen.
- Assigning generated files or correcting a message repeats preparation and checks in a new call.

## Alternatives considered

### Approval with a startup flag

Keep approval with a startup flag. Rejected because this keeps two execution paths and requires
launcher setup for unattended work.
