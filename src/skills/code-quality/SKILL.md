---
name: code-quality
description:
  Review the structure of a branch diff or named files with a fresh finder and a fresh checker. It
  looks for simpler designs, not bugs; use code-review for defects. Use it for "/code-quality",
  "review the structure of my branch", or "review the code quality of these files". It never edits,
  fixes, commits, or pushes. On the user's own work, it then acts on the supported findings with
  triage-findings, unless the user asked for a read-only review.
---

# Code quality

## When to use

Use this skill to review the structure of local code: the current branch, uncommitted work, a commit
or range, or named files. It needs the `subagent` tools inside herdr. Without them, tell the user
and stop. For defects, use the [code-review](../code-review/SKILL.md) skill.

## Hard rules

- Until the report is saved, change nothing: no edits, fixes, stages, commits, pushes, publishes,
  checkouts, resets, or stashes. Stop when the user says stop.
- The user's own work follows the ownership rule of
  [code-review](../code-review/SKILL.md#hard-rules). Anything unclear is not the user's own.
- The report gives the target no approval, no verdict, and no clean result. Never call an incomplete
  or stale review clean.
- Launch workers with the `reviewer` profile and the [quality assignment](quality-assignment.md).
  Omit `model` unless the user names one.
- If a launch fails, follow the retry rule of [code-review](../code-review/SKILL.md#hard-rules). Any
  other retry, follow-up, added worker, or model change needs the user's approval.
- Aim for about 10 minutes, and follow the rules for the aim in
  [code-review](../code-review/SKILL.md#hard-rules).
- Run no full check, post no ticket comment except in step 7, and do not review a fix or run this
  skill again on its own.
- After the report, act on findings only on the user's own work, and never after a request for a
  read-only review or "no changes". Acting never approves a publish or absorbing unrelated changes.

## Procedure

1. Resolve the target once as a `code_review` target, with every revision pinned by `git rev-parse`.
   - A branch diff: a `workingTree` from `git merge-base <default> HEAD`. Named files: a `files`
     target, which reviews them even without changes.
   - Any other target, such as uncommitted work, a commit, or a range, follows step 1 of
     [code-review](../code-review/SKILL.md#procedure). Never use a `fix` target.
   - Pass declared exclusions as `exclude`. Ask when the target, base, or ownership is unclear.

2. Call `code_review` `prepare`, and use the returned directory as `$dir`. Write `$dir/input.md`
   from the [input template](../code-review/input.md), with the mode `quality`. Then call `capture`
   with `$dir` and the target. If either call fails, stop and report the error.
   - Handle `unmatched`, `empty`, and a moved `head` or `base` as step 2 of
     [code-review](../code-review/SKILL.md#procedure) does.

3. Gather evidence as step 3 of [code-review](../code-review/SKILL.md#procedure) does. Call
   `code_review` `evidence` and save the result as `$dir/evidence.md`.

4. Launch the workers in order.
   - Finder: the `reviewer` profile with
     [quality-assignment.md#quality-lens](quality-assignment.md#quality-lens).
   - Checker: a fresh `reviewer` worker with `#quality-lens` and
     [quality-assignment.md#checker](quality-assignment.md#checker), plus the finder's report or the
     path `$dir/finder.md`. Launch it even when the finder found nothing.
   - Follow only these parts of step 4 of [code-review](../code-review/SKILL.md#procedure): the
     pre-existing issues line on the user's own work, the elapsed-time check, failed workers, and
     finished results. Do not add its finder line about every plausible candidate.

5. Call `code_review` `freshness` with `$dir`. Report `fresh` as fresh. Label `stale` with its
   reasons and ask whether to review again. Report `unknown`, or a failed call, as unknown. Keep the
   finished results in every case.

6. Save the worker reports and `$dir/report.md` with the [report template](report.md).

7. Post `$dir/report.md` to the ticket, before any fixing. Skip this step without a ticket.
   - Find the ticket as the last bullet of step 1 of
     [code-review](../code-review/SKILL.md#procedure) says. For a `files` target with no ticket
     named by the user or a calling skill, there is no ticket.
   - Start `$dir/report.md` with the line `# Code quality: <ticket>` when it lacks one.
   - Call `tracker_draft` `prepare` with the ticket identifier in lower case. Find the earlier
     report with the tracker skill's comment list command: the comment with ID
     `draft.qualityCommentId`, or with none recorded, the one whose first line is
     `# Code quality: <ticket>`. Never use the code-review comment ID or a `# Code review:` comment.
     Read its text from that list.
   - Post without asking, as [Hard rules](../tracker/SKILL.md#hard-rules) allows, only when the work
     and the ticket are both the user's own, as the tracker skill defines a ticket. Otherwise ask
     with `ask_user_question` first, and skip the post if the user declines.
   - Update the earlier comment when one exists, and never add a second one. Otherwise add one.
     Record its ID at once, in `$dir/report.md` as a `Comment ID:` line and as `qualityCommentId` in
     the returned `draft.json`. Write the returned draft back with `"version": 2` and every other
     field kept, or create it as
     `{"version": 2, "identifier": "<ticket>", "reviewCommentId": null, "qualityCommentId": "<id>"}`.
   - If the post fails, keep the local report and say so in the reply.

8. Reply with the [report template](report.md). Name the comment URL, or say the report stays local.
   Name any Linear edits the update replaced.
   - Findings on the user's own work, without a request for a read-only review or "no changes":
     continue with the [triage-findings](../triage-findings/SKILL.md) skill without asking. Then ask
     about any gap, failure, or stale result that needs a decision.
   - Any other findings: end with one question that proposes actions, such as "Fix 1 and 2, and
     investigate 3?", and includes any decision a gap or stale result needs. Act on the approved
     findings with triage-findings.
   - Without findings, ask only about a gap, failure, or stale result that needs a decision.
