# ADR 0016: Staged message and hook policy

- Status: Proposed
- Date: 2026-09-10

## Context

Git hooks can repeat expensive checks or rewrite approved content and messages. Unstaged
configuration must not disable validation for the staged candidate. Message edits need validation
without repeating preparation, project checks, or comment review.

## Options considered

- Use `--no-verify`. Leaves some hooks active, including `prepare-commit-msg`.
- Change repository hook configuration. Also changes later human commits.
- Select policy from staged configuration and scope bypass to one Git command. Keeps human hooks
  independent and makes the candidate's policy explicit.

## Decision

This replaces the reserved message and hook settings in
[ADR 0013](./0013-explicit-repository-commit-commands.md). Keep working configuration for
preparation; select `check`, optional `checkMessage` argv, and `hooks: run|skip` from the actual
staged candidate. Default hooks to `run`. Reject invalid settings rather than silently weakening
validation.

Append an absolute temporary full-message file path to `checkMessage` argv, without an implicit
shell. This supports ecosystem-neutral checkers without command discovery. Reject NUL in subject and
body. Keep subject validation; normalize body CRLF and CR to LF, preserve other whitespace, and
append LF to a nonempty body when missing. An absent or empty body produces `subject + LF`;
otherwise use `subject + LF + LF + body`. Display the normalized subject and body.

Use that file with `git commit --cleanup=verbatim -F` so Git receives the checked bytes without
another cleanup rule. Reject checker changes to the message, tracked candidate files, index, or
nonignored untracked files, even after command failure. Stop rather than reuse a contaminated
candidate. Reject special message files before reading them. Hook message rewrites undo the commit
and require retry with the final message, just as reviewed-content rewrites do.

Share one staged checkout per group for project and message checks. Message edits rerun only message
validation. Unavailable validation is not a pass; failed validation cannot be waived or preapproved.

For `hooks: skip`, pass `-c core.hooksPath=<temporary-empty-directory>` only to the final Git
commit. Do not change human Git configuration or pass bypass settings to preparation or checks.
Agents cannot bypass hooks ad hoc. Raw commits stay guarded, and review, TDD, tree, and path guards
remain in force.

Dispose temporary resources on success, failure, cancellation, skip, or decline. Cleanup diagnostics
must preserve primary errors and hashes of completed groups, including a commit that just succeeded.

## Tradeoffs

- Hook policy becomes explicit without changing human workflows.
- Message whitespace is predictable rather than subject to Git's default cleanup.
- Candidate checks remain cooperative commands, not a sandbox. Ignored artifacts, shared
  dependencies, and background writers remain outside mutation guarantees. Workspace/dependency
  setup is separate.
- A killed Tau process cannot run cleanup. Normal checker termination and cancellation still dispose
  the group's resources.
