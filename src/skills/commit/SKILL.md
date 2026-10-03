---
name: commit
description:
  Create Git commits in logical groups with the `commit` tool. Use reported errors to decide how to
  retry failed commits.
---

# Commit

Use this skill when the user wants to commit changes from the current working tree. The `commit`
tool runs without a prompt.

## Hard rules

- Use the `commit` tool for every commit, never `git commit` through bash. If the tool is
  unavailable, stop and tell the user.
- Never stage with `git add -A` or `git add .`, or rewrite history with `--amend`.
- Stage only files in the requested groups. Installed hooks may add paths, which the tool reports.

## Procedure

1. Read the current Git state.
   - Run `git status --porcelain`, `git diff`, and `git diff --cached`.
   - Read untracked files before grouping them. Use the diffs for tracked files unless ambiguous.
   - If there are no changes, report the clean tree and stop.
   - Account for pre-staged files before calling `commit`. Assign each to a group, or unstage only
     staging you or the user created with `git reset HEAD -- <file>`. Leave concurrent staging
     untouched.

2. Plan exact, ordered groups.
   - Prefer small commits that each make one isolated change. Split unrelated changes into separate
     groups.
   - Keep each commit coherent enough to pass hooks and checks on its own. Keep a manifest with its
     lockfile, and tests with the code they cover.
   - Commit dependency additions as their own `build(deps)` group before the code that uses them.
     Keep upgrades with breaking changes and dependency removals in the group with the code they
     affect.
   - Commit refactors that a change relies on before the change itself.
   - Commit documentation as its own `docs` group unless it describes only the change in the same
     group.
   - Treat a group of more than about 10 files, or one that spans several concerns, as a sign to
     look for a further split. Keep it together only when the parts cannot stand alone.
   - The tool stages on the real index, so hooks also see unrelated working edits. For a file with
     edits for several groups, choose the best-fitting group and report that choice. Do not split
     hunks.
   - Give each group an exact `files` list. Use the optional `body` to explain why the change was
     made.

3. Call `commit` with the ordered `groups` array.
   - The tool runs groups in order and stops on failure. Earlier successful commits remain.
   - Report created commits, actual committed paths, hook rewrites, and any errors.

4. On failure, read the tool's error before deciding what to retry.
   - If the user cancelled, stop without retrying, even when the tool reports an error.
   - Otherwise, run `git status --porcelain` and compare the remaining changes with the reported
     commits. Do not infer commit success from a clean tree alone.
   - For staging conflicts, inspect current changes. Never restore files or staging over concurrent
     edits.
   - Fix the reported cause. Do not alter hooks to clear a blocker. Include only files that belong
     to the fix.
   - A hook failure unstages the requested files and returns raw output, unless HEAD changed or
     unstaging failed. Read any cleanup diagnostic before changing the index.
   - Successful hook rewrites and added paths stay committed. If a hook consumed a later group's
     changes, the batch stops when that group has no staged changes. Inspect the reported commits
     and remaining changes. Do not retry committed groups.
   - If reporting fails after the commits succeed, inspect Git history before retrying.
   - Retry only the corrected and remaining groups that were not committed. Stop after three failed
     retries of the same group and report the blocker.

Stop when the requested groups are committed or the user stops the operation. Do not expand the task
just to make the working tree clean.
