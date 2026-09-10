---
name: commit
description:
  Create Git commits in logical groups with the `commit` tool. Use reported errors to decide how to
  retry failed commits.
---

# Commit

## When to use

Use this skill when the user wants to create one or more Git commits from the current working tree.

## Goal

Turn the current diff into clean commits using the `commit` tool.

## Hard rules

- Use the `commit` tool for every commit. Do not run `git commit` through bash.
- If the `commit` tool is unavailable, stop and tell the user.
- Never stage with `git add -A` or `git add .`.
- Never pass `--no-verify`.
- Never rewrite history with `--amend`.
- Do not ask for chat-level confirmation. The `commit` tool handles approval. When Pi starts with
  `--auto-approve-commits`, the tool skips confirmation but keeps checks and comment review.
- Never enable preapproval yourself to bypass a blocked commit. If review needs a human waiver in
  preapproved mode, stop and report the blocker.
- Every commit subject must use conventional-commit format.
- Every commit should include a body explaining why the change was made.
- Stage and commit only the files that belong to the current logical group. Assign each path to only
  one group.
- The `commit` tool rejects sensitive paths (`.env*`, credentials, keys). Remove rejected files from
  the group instead of retrying.

## Procedure

1. Read the current Git state before proposing anything.
   - Run `git status --porcelain`.
   - Run `git diff` for unstaged changes and `git diff --cached` for staged changes.
   - For untracked files shown by `git status`, read them or run
     `git diff --no-index /dev/null <file>` to understand their content before grouping.
   - Use the diff output directly to understand what changed. Do not read individual files unless a
     diff is genuinely ambiguous.
   - If there are no relevant changes (nothing staged, nothing modified), tell the user the working
     tree is clean and stop.
   - If files are already staged, explicitly assign each to a commit group or unstage them with
     `git reset HEAD -- <file>` before proceeding. Never leave unassigned staged files. The tool
     commits only files listed in its pathspecs, but stale index state causes confusion.

2. Identify logical commit groups.
   - Split unrelated changes into separate groups. The tool stages whole files, so every change in a
     file goes to the same group.
   - When one file contains changes with different purposes, put it in the group that fits best.
     Report that choice instead of trying to split the file.
   - Keep each group coherent and reviewable.
   - For each group, prepare a conventional-commit subject and the exact file list.

3. Call the `commit` tool once with an ordered `groups` array. Each group contains `files`,
   `subject`, and `body`. The tool runs configured commands, reviews changes, and handles approval.
   Do not run those commands separately to duplicate the tool's work. Report unavailable checks as
   unavailable, not passed. With preparation configured, expect separate approval for each group
   unless Pi started with `--auto-approve-commits`.

4. If the `commit` tool succeeds, report the result and continue.
   - A skipped group is not a failure; the tool continues with later groups.
   - Note each created commit and any skipped groups.

5. If the `commit` tool fails, read the current state before investigating.
   - The error lists groups already committed with their identifiers and commit hashes. Exclude them
     from retries.
   - Run `git status --porcelain` first. If the working tree is clean, the changes were already
     committed, for example by a prior group. Report this and move on.
   - If changes remain, use the tool's error output to guide retries:
     - Read the reported command, configuration, hook, or review error.
     - Fix the underlying issue, such as lint, format, or test failures.
     - If preparation reports additional files, inspect them before assigning them to a group and
       retrying. Do not add unrelated user edits just to clear an error.
     - If the tool reports an ownership conflict, stop and inspect the current changes. Follow any
       recovery instructions before restoring files or staging. A failed commit does not undo
       preparation's working edits.
     - Include files that belong to the fix in the retried group's `files` list.
     - Retry the `commit` tool with the corrected group and any remaining groups in `groups`. Leave
       out the groups already committed and the ones the user skipped; a skipped group carries no
       commit hash, so its absence from the error's list does not mean it still needs a commit.
     - Cap retries at 3 for the same group.
     - After 3 failed retries, stop and report the failure to the user instead of pushing through.

6. Continue until done.
   - Loop until the working tree is clean or the user tells you to stop.
   - If the user declines a commit in the confirmation dialog, stop or re-plan based on their
     instructions.

## Checklist

- Confirmed the current state with `git status --porcelain`, `git diff`, and `git diff --cached`.
- Assigned every pre-staged file to a group or unstaged it.
- Split changes into logical groups.
- Proposed each group with exact files, a conventional-commit subject, and a body.
- Used the `commit` tool, not bash, for every commit. The tool handles user confirmation.
- On failure, checked `git status` before investigating.
- On failure, read the error text, fixed the cause, and retried no more than 3 times.
- Stopped when the working tree was clean or the user chose to stop.

## See also

- [Skill authoring style](../../docs/adr/0004-skill-authoring-style.md)
- [Staged preparation ownership](../../docs/adr/0014-staged-preparation-ownership.md)
