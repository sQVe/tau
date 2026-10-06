# ADR 0018: Repository owners choose commit checks and hooks

**Date**: 2026-09-10\
**Status**: Superseded\
**Superseded by**:
[ADR 0026 (Let Git hooks own commit checks)](./0026-let-git-hooks-own-commit-checks.md)\
**Related**: [ADR 0024 (Commit without human approval)](./0024-commit-without-human-approval.md)
replaces in-place message editing with a new commit call; check and hook policy remain unchanged,
[ADR 0023 (Use advisory TDD observations instead of edit permissions)](./0023-advisory-tdd-observations.md)
later replaced TDD enforcement with hints; commit checks, review, approval, and safeguards remain
independent of those hints

## Context

Git hooks can repeat expensive checks or rewrite approved content and messages. Repository owners
need to choose Tau's validation policy without changing hooks for human commits. Unrelated working
edits must not weaken checks for staged files.

## Decision

The repository owner configures check commands and hook policy in `tau.json`. Tau reads policy from
staged configuration and limits hook skipping to its final commit command, so owners set the policy,
and human commits stay unchanged.

Tau reads the version of `tau.json` staged for this commit to select `check`, optional
`checkMessage`, and `hooks`. Unstaged configuration edits must not change the checks applied to
staged code.

Hooks run by default; the owner can skip them with the JSON setting `"hooks": "skip"`. With this
setting, Tau gives only its final `git commit` an empty hooks directory, leaving repository Git
configuration and later human commits unchanged. The agent cannot bypass hooks on its own.

Optional `checkMessage` is a repository command that checks the proposed full commit message against
repository rules, such as a required subject format. It checks the exact message that will be
committed. Editing only the message reruns that command without repeating preparation, project
checks, or comment review.

Invalid configuration stops the commit. Unavailable checks are not a pass, and failed checks cannot
be waived. Checks must not change the files or message being approved; Tau stops if they do. Hook
rewrites require undoing the commit and retrying.

Skipping hooks does not skip approval, comment review, or content and path safeguards. Working
configuration still selects preparation. This replaces the reserved message and hook settings in
[ADR 0015](./0015-explicit-repository-commit-commands.md).

## Consequences

### Positive

- Owners can avoid duplicate hook work without changing human workflows.

### Negative

- Owners must configure Tau's checks explicitly.
- Running repository commands does not isolate shared dependencies or other running processes.

## Alternatives considered

### `--no-verify`

Use `--no-verify`. Rejected because some hooks still run, including `prepare-commit-msg`.

### Disable hooks repository-wide

Disable hooks repository-wide. Rejected because this also changes human commits.

### Agent bypasses failing hooks

Let the agent bypass hooks when they fail. Rejected because this gives the agent control over
repository policy.
