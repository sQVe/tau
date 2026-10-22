---
name: prune-comments
description:
  Delete comments that name no wrong change a reader would make. Use it for "/prune-comments" or
  "remove comments that restate the code". It only deletes; it never rewords or adds.
---

# Prune comments

## When to use

Use this skill to delete comments in local code: the current branch diff, a commit or range, or
named files. It needs the `subagent` tools inside herdr. Without them, tell the user and stop. It
does not review code. For that, use [code-quality](../code-quality/SKILL.md) or
[code-review](../code-review/SKILL.md).

## Hard rules

- The skill only deletes comments. It never rewords or adds a comment, and it does not use
  [triage-findings](../triage-findings/SKILL.md).
- A diff target judges only the comments the diff adds or changes. Named files judge every comment
  in them.
- Launch one fresh worker with the `reviewer` profile and the [brief](brief.md). Omit `model` unless
  the user names one.
- A failed worker deletes nothing. Report a gap and stop. Do not relaunch the worker.
- The user's own work follows the ownership rule of
  [code-review](../code-review/SKILL.md#hard-rules). Anything unclear is not the user's own.
- Post no ticket comment.

## Procedure

1. Resolve the target as in [Resolve the target](../code-review/phases.md#resolve-the-target).
   - A branch diff is the default: a `workingTree` from `git merge-base <default> HEAD`.
   - A commit or range is a `range`. Named files are a `files` target.

2. Prepare and capture as in
   [Handle the capture result](../code-review/phases.md#handle-the-capture-result).

3. Gather evidence as in [Gather evidence](../code-review/phases.md#gather-evidence).

4. Launch the worker with the [brief](brief.md). Save its report as `$dir/prune.md`. If the worker
   fails or leaves no report, delete nothing, report the gap, and stop.

5. Call `code_review` `freshness` with `$dir`. On `stale` or `unknown`, delete nothing and ask the
   user whether to capture again.

6. Delete by whose work it is, and by whether the user asked for a read-only run. Delete only the
   comments the report marks `delete`, and keep the code around them unchanged.
   - Own work, no read-only request: delete without a prompt. Make one commit with the `commit` tool
     and a conventional subject, such as `style: remove comments that restate the code`. List each
     removal as `file:line`. If a target file has other uncommitted edits, ask first, because the
     commit stages whole files.
   - Other work, or a read-only request: list each delete as `file:line` with its text, and ask with
     `ask_user_question` before you delete. Delete only what the user approves.

7. Reply with the removals, the count of kept comments, and any gap.
