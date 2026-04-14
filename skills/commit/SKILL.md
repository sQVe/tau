---
name: commit
description:
  Create confirmed, logically grouped git commits with the `commit` tool and evidence-driven retry
  handling.
---

# Commit

## When to use

Use this skill when the user wants to create one or more git commits from the current working tree.

## Goal

Turn the current diff into clean, user-confirmed commits using the `commit` tool.

## Hard rules

- Use the `commit` tool for every commit. Do not run `git commit` through bash.
- If the `commit` tool is unavailable, stop and tell the user.
- Never stage with `git add -A` or `git add .`.
- Never pass `--no-verify`.
- Never rewrite history with `--amend`.
- Do not ask for chat-level confirmation. The `commit` tool's dialog is the only approval step.
- Every commit subject must use conventional-commit format.
- Every commit should include a body explaining why the change was made.
- Stage and commit only the files that belong to the current logical group.
- The `commit` tool rejects sensitive paths (`.env*`, credentials, keys). Remove rejected files from
  the group instead of retrying.

## Procedure

1. Gather the current git state before proposing anything.
   - Run `git status --porcelain`.
   - Run `git diff` for unstaged changes and `git diff --cached` for staged changes.
   - For untracked files shown by `git status`, read them or run
     `git diff --no-index /dev/null <file>` to understand their content before grouping.
   - Use the diff output directly to understand what changed. Do not read individual files unless a
     diff is genuinely ambiguous.
   - If there are no relevant changes (nothing staged, nothing modified), tell the user the working
     tree is clean and stop.
   - If files are already staged, explicitly assign each to a commit group or unstage them with
     `git reset HEAD -- <file>` before proceeding. Never leave unassigned staged files — the tool
     commits only pathspec-listed files, but stale index state causes confusion.

2. Identify logical commit groups.
   - Split unrelated changes into separate groups, including within a single file when hunks have
     different intents (e.g. a palette edit and an unrelated env var change in the same config).
   - Keep each group coherent and reviewable.
   - For each group, prepare a conventional-commit subject and the exact file list (or hunk
     selection, staged with `git add -p` before calling the tool).

3. Present the proposed groups briefly, then call the `commit` tool immediately.
   - For each group, call the `commit` tool with the file list, subject, and body.

4. If the `commit` tool succeeds, report the result and continue.
   - Note the created commit.
   - If more uncommitted groups remain, continue calling the tool for the next group.

5. If the `commit` tool fails, triage before investigating.
   - Run `git status --porcelain` first. If the working tree is clean, the changes were already
     committed (e.g., absorbed by a prior group). Report this and move on.
   - If changes remain and the failure includes `hookFailed`, handle it as an evidence-driven retry
     loop:
     - Read the `stderr` field carefully.
     - Diagnose the actual failure from the hook output.
     - Fix the underlying issue, such as lint, format, or test failures.
     - Include any files modified during the fix in the retry's `files` list.
     - Retry the `commit` tool call for that group.
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
- On `hookFailed`, read `stderr`, fixed the cause, and retried no more than 3 times.
- Stopped when the working tree was clean or the user chose to stop.

## See also

- `docs/adr/0004-skill-authoring-style.md`
