---
name: commit
description:
  Create Git commits in logical groups with the `commit` tool. Use reported errors to decide how to
  retry failed commits.
---

# Commit

Use this skill when the user wants to commit changes from the current working tree.

## Hard rules

- Use the `commit` tool for every commit, never `git commit` through bash. If the tool is
  unavailable, stop and tell the user.
- Never stage with `git add -A` or `git add .`, or rewrite history with `--amend`.
- Never bypass hooks with `--no-verify`, `core.hooksPath`, environment variables, or configuration
  changes to evade a failure. Leave hook policy to the repository owner and the commit tool.
- Do not ask for chat-level confirmation. The tool handles approval. Never enable preapproval
  yourself or claim a human review waiver. If preapproved mode needs a human waiver, stop and report
  the blocker.
- Commit only files in the requested groups. Never add unrelated edits or rejected sensitive files
  to clear an error. Preapproval does not authorize additional files.

## Procedure

1. Read the current Git state.
   - If an earlier commit call reported pending recovery, report the retained data and stop. Follow
     its recovery instructions before changing files or staging. A clean-looking working tree during
     pending recovery does not prove work was committed.
   - Run `git status --porcelain`, `git diff`, and `git diff --cached`.
   - Read untracked files before grouping them. Use the diffs for tracked files unless ambiguous.
   - If there are no changes and no recovery blocker, report the clean tree and stop.
   - Assign each pre-staged file to a group or unstage it with `git reset HEAD -- <file>`.

2. Plan exact, ordered groups.
   - Split unrelated changes into separate groups. Assign each path to only one group.
   - The tool stages whole files. For mixed-purpose files, choose the best-fitting group and report
     that choice rather than splitting hunks.
   - Give each group an exact `files` list, a conventional-commit `subject`, and a `body` explaining
     why the change was made.

3. Call `commit` with the ordered `groups` array.
   - Do not manually duplicate the tool's preparation or checks.
   - Report unavailable checks as unavailable, not passed.
   - Report created commits, skipped groups, and any preparation-added files. A skipped group is not
     a failure or permission to retry it.

4. On failure, read the tool's error before deciding what to retry.
   - Handle pending recovery first: report retained data and stop, even if Git status looks clean.
     For staging conflicts, inspect current changes and follow recovery instructions. Never restore
     files or staging over concurrent edits. Preparation failures leave working edits in place.
   - If the user declined or cancelled, stop without retrying, even when the tool reports an error.
   - Otherwise, run `git status --porcelain` and compare the remaining changes with reported
     commits. Do not infer commit success from a clean tree alone.
   - Fix the reported cause. Do not alter human hooks to clear a blocker. Include only files that
     belong to the fix.
   - Inspect preparation-added files and obtain explicit assignment before including them in a
     retry. Do not expand into unrelated edits or another group's files.
   - Prepared result paths are repository-relative. Convert them before retrying from a nested
     directory; retry from the repository root if an added path is outside that directory.
   - Retry only corrected and remaining groups that were neither committed nor skipped. Stop after
     three failed retries of the same group and report the blocker.

Stop when the requested groups are committed or skipped, or the user stops the operation. Do not
expand the task just to make the working tree clean.
