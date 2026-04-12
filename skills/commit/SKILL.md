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
- Every commit subject must use conventional-commit format.
- Every commit should include a body explaining why the change was made.
- Stage and commit only the files that belong to the current logical group.
- The `commit` tool rejects sensitive paths (`.env*`, credentials, keys). Remove rejected files from
  the group instead of retrying.

## Procedure

1. Gather the current git state before proposing anything.
   - Run `git status --porcelain`.
   - Run `git diff` and `git diff --cached`. Inspect per-file diffs when the combined diff is
     unclear.
   - If there are no relevant changes, tell the user the working tree is clean and stop.

2. Identify logical commit groups.
   - Split unrelated changes into separate groups.
   - Keep each group coherent and reviewable.
   - For each group, prepare a conventional-commit subject and the exact file list.

3. Present the proposed groups, then call the `commit` tool for each group in order.
   - Show all proposed groups before starting.
   - For each group, call the `commit` tool with the file list, subject, and body.
   - The tool prompts the user for confirmation before committing. Do not ask separately.

4. If the `commit` tool succeeds, report the result and continue.
   - Note the created commit.
   - Re-check the working tree as needed.
   - If more uncommitted groups remain, continue calling the tool for the next group.

5. If the `commit` tool fails with `hookFailed`, handle it as an evidence-driven retry loop.
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
- Split changes into logical groups.
- Proposed each group with exact files, a conventional-commit subject, and a body.
- Used the `commit` tool, not bash, for every commit. The tool handles user confirmation.
- On `hookFailed`, read `stderr`, fixed the cause, and retried no more than 3 times.
- Stopped when the working tree was clean or the user chose to stop.

## See also

- `docs/adr/0004-skill-authoring-style.md`
