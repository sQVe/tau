# ADR 0024: Commit without human approval

- Status: Proposed; preparation and check rules superseded by
  [ADR 0025](./0025-use-git-hooks-without-preparation.md); comment review removed by
  [ADR 0042](./0042-remove-commit-comment-review.md)
- Date: 2026-09-15

## Context

Commit approval makes unattended workers depend on a startup flag and a person who can resolve
blocked screens. A terminal UI does not mean a person is present. Commit failures need to reach the
agent so it can correct the request or report the blocker.

## Options considered

- Keep approval with a startup flag. This keeps two execution paths and requires launcher setup for
  unattended work.
- Remove human approval from every commit call. This gives interactive and unattended workers the
  same error and retry path.

## Decision

Commit without human approval in every mode. Remove the startup flag, approval overlay, message
editor, and review waivers. Failed message checks and blocking comment reviews return tool errors.
Message corrections require a new call.

Preparation-added paths still require inspection and explicit assignment in a new call. Generated
output alone does not authorize adding files to a commit. Preparation, recovery, repository checks,
and post-commit safeguards remain in place.

This replaces [ADR 0011](./0011-commit-preapproval.md) and
[ADR 0017](./0017-preparation-addition-assignment.md). It also replaces the in-place message editing
rule in [ADR 0018](./0018-staged-message-and-hook-policy.md), not its check or hook policy.

## Tradeoffs

- Workers do not wait for commit approval or require a launcher flag.
- Blocking failures use one correction path in every mode.
- Cost: users no longer inspect or edit a commit in a final approval screen.
- Cost: assigning generated files or correcting a message repeats preparation and checks in a new
  call.
