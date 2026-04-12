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
- Always get explicit user confirmation before creating each commit.
- Every commit subject must use conventional-commit format.
- Stage and commit only the files that belong to the current logical group.
- The `commit` tool rejects sensitive paths (`.env*`, credentials, keys). Remove rejected files from
  the group instead of retrying.

## Procedure

1. Gather the current git state before proposing anything.
   - Run `git status --porcelain`.
   - Run `git diff`. Inspect per-file diffs when the combined diff is unclear.
   - If there are no relevant changes, tell the user the working tree is clean and stop.

2. Identify logical commit groups.
   - Split unrelated changes into separate groups.
   - Keep each group coherent and reviewable.
   - For each group, prepare a conventional-commit subject and the exact file list.

3. Present the plan to the user before committing.
   - Show each proposed group separately.
   - For each group, include the subject, body, and exact files.
   - Ask for explicit confirmation for the next commit group before calling the tool.

4. After the user confirms a group, call the `commit` tool with the confirmed file list, subject,
   and body.

5. If the `commit` tool succeeds, report the result and continue.
   - Note the created commit.
   - Re-check the working tree as needed.
   - If more uncommitted groups remain, repeat the proposal and confirmation cycle.

6. If the `commit` tool fails with `hookFailed`, handle it as an evidence-driven retry loop.
   - Read the `stderr` field carefully.
   - Diagnose the actual failure from the hook output.
   - Fix the underlying issue, such as lint, format, or test failures.
   - Include any files modified during the fix in the retry's `files` list.
   - Retry the `commit` tool call for that group.
   - Cap retries at 3 for the same group.
   - After 3 failed retries, stop and report the failure to the user instead of pushing through.

7. Continue until done.
   - Loop until the working tree is clean or the user tells you to stop.
   - If the user declines a proposed commit, stop or re-plan based on their instructions.

## Checklist

- Confirmed the current state with `git status --porcelain` and `git diff`.
- Split changes into logical groups.
- Proposed each group with exact files and a conventional-commit subject.
- Got explicit user confirmation before each commit.
- Used the `commit` tool, not bash, for every commit.
- On `hookFailed`, read `stderr`, fixed the cause, and retried no more than 3 times.
- Stopped when the working tree was clean or the user chose to stop.

## See also

- `docs/adr/0004-skill-authoring-style.md`
