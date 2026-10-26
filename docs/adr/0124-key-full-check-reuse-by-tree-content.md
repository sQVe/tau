# ADR 0124: Key full check reuse by tree content and command

**Date**: 2026-10-26\
**Status**: Accepted\
**Related**: [ADR 0105 (Queue full checks per repository and reuse passing logs)](./0105-queue-full-checks-per-repository-and-reuse-passing-logs.md),
[ADR 0094 (Compose PR publication evidence)](./0094-compose-pr-publication-evidence.md)

## Context

A passing full check log can be reused only for the same state. ADR 0105 keyed that state by the
head commit, the base commit, and a fingerprint of the working tree. The head and base add keys
without adding safety. The command reads files, and the files are what change the result.

A commit or an amend that changes no files gives the same files as before. A base change does the
same. Under the old key, both reran a check that had already passed on the same content. The `pr`
skill also had to pass the merge base to `full_check` only to build that key.

## Decision

The full check record is keyed by the tree ID of the working state and by the configured command.
The head commit, the merge base, and the base branch are not part of the key.

The tree ID comes from Git. Tau stages every change, untracked files included, into a temporary copy
of the index and writes the tree from it, so the real index stays unchanged. Two states with the
same files have the same tree ID, whatever their commits are.

Tau stages with attribute conversions and filters turned off, so the raw bytes of a changed file
form its blob. An active rule in `.git/info/attributes`, which Tau cannot turn off, makes the state
unreusable.

Reuse and the `pr` tool's `evidence` action take the newest record for the tree. A newer record of
another command, passed or failed, makes the answer `missing` for the configured command. Reuse runs
the check again in that case, and evidence reports a gap until the configured command runs.

The record is version 3 and holds the tree ID, the command, and whether the run passed. A version 2
record reads as malformed and is never reused, so the first check on each state runs again.

## Consequences

### Positive

- A commit or amend that changes no files does not rerun a passing full check.
- A moved base does not rerun a check on unchanged files.
- `full_check` takes no base, so callers cannot key reuse on a base by mistake.

### Negative

- A dirty submodule has no tree ID that Tau can compute. Its state is never reusable, so its checks
  run every time.
- Git keeps the stored blob of a tracked file whose stat data did not change. When a normalizing
  rule, such as `*.txt text eol=lf`, made that blob differ from the file's bytes, a later edit to
  those same bytes, such as a switch between CRLF and LF, keeps the tree ID. A check that reads raw
  bytes can then reuse a stale pass. The key from ADR 0105 had the same gap for tracked files.
- Git does not restage a file marked assume-unchanged or skip-worktree, so an edit to it keeps the
  tree ID. The key from ADR 0105 had the same gap.
- A record names no commit. A reader of a saved log learns the files it covered, not the commit it
  was made on.

## Alternatives considered

### Keep the head and merge base in the key

Keep ADR 0105's key. Rejected because it reran checks on unchanged files after a commit or a base
move, and it required every caller to pass the base.

### Hash only the tracked changes against HEAD

Keep the head and a hash of the tracked changes. Rejected because the head still keys the reuse, and
the hash needs a separate pass over untracked files. One tree ID from Git covers both.
