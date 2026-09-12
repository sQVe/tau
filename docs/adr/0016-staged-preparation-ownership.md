# ADR 0016: Prepare each commit with separate staging

- Status: Proposed
- Date: 2026-09-10

## Context

Preparation is a command configured by the repository in `tau.json` that may format or generate
files. One request can contain several planned commits. Running preparation before their files are
selected gives commands that read Git's staging area no way to identify the current commit. Using
the user's staging area directly risks changing what the user already selected.

## Options considered

- Prepare in shared staging and restore on failure. Restoration can overwrite newer selections made
  by another process.
- Include every changed file. Absorbs unrelated work without permission.
- Prepare with separate staging and backups. Keeps preparation's selections apart from the user's.

## Decision

Run preparation for each planned commit using a temporary copy of Git's staging area. Preparation
still runs in the current checkout. Select that commit's files in the copy before running
preparation. Run checks, review, and approval afterward so they cover the prepared changes.

Back up existing staging and working files first: tracked files and nonignored untracked files
within the backup's size and file-type limits. Require explicit assignment for additional files: the
user chooses whether they belong in this commit. Exclude unrelated edits and files planned for other
commits.

Copy the prepared selections back only if shared staging has not changed since the backup. For a
failed, cancelled, or skipped commit, restore original staging only if staging still matches what
Tau put there. If another process has changed it, stop and retain the backup rather than overwrite
its selections. After a successful commit, discard the preparation backup instead of restoring
original staging.

Never restore working files automatically after preparation fails: they may contain newer edits.
[Later checks](./0020-checks-in-the-existing-checkout.md) temporarily hide unrelated working edits
to test the selected content, then restore those edits from a verified backup.

This replaces preparation ordering and recovery in
[ADR 0015](./0015-explicit-repository-commit-commands.md), not its configuration or hook policy.

## Tradeoffs

Separate staging isolates what gets staged, not which working files preparation can change in the
current checkout. Tau does not automatically undo those edits. Backups cost storage and may need
manual recovery; writes outside their coverage remain unprotected.
