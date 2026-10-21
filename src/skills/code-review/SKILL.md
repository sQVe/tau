---
name: code-review
description:
  Review local code changes with fresh subagent workers. Fast by default with one self-checking
  reviewer; deep adds a fresh checker. Use it for "/code-review", "/code-review fast", "/code-review
  deep", "review my branch", "review these changes", or a review of a commit, range, or files. The
  review never edits, fixes, commits, or pushes. Its only outside write is the report comment on the
  reviewed ticket, which it posts as the tracker skill's rule allows. On the user's own work, it
  then fixes the supported findings with triage-findings, unless the user asked for a read-only
  review.
---

# Code review

## When to use

Use this skill to review local code: the current branch, uncommitted work, a commit or range, or
named files. It needs the `subagent` tools inside herdr. Without them, tell the user and stop.

## Hard rules

- Until the report is saved, change nothing: no edits, fixes, stages, commits, pushes, publishes,
  checkouts, resets, or stashes. The one outside write is the report comment of step 7, made with
  the [tracker skill](../tracker/SKILL.md)'s comment commands under its
  [Hard rules](../tracker/SKILL.md#hard-rules). Stop when the user says stop.
- The work is the user's own only when its branch is, never decided from the checkout alone: the
  user often checks out other people's PRs. A branch is the user's own when its PR author is the
  `gh api user --hostname <PR host> --jq .login` login, or, with no PR, when each of its commits has
  the author email `git config user.email`. A branch with no commits of its own counts when nothing
  points to another author. Uncommitted work follows its branch. Anything unclear is not the user's
  own.
- Mode: fast unless the user asks for deep. "Full diff" names the scope, not the mode. Fast launches
  one reviewer. Deep launches a finder, then a fresh checker.
- A first review covers the whole target. A fix review captures only the fix, its callers, and the
  findings it closes. Never reuse earlier findings or verdicts.
- Launch workers with the `reviewer` profile and the [review assignment](review-assignment.md). Omit
  `model` unless the user names one. Omit `timeoutSeconds` unless the user names a cheap model; then
  set a shorter one.
- If a launch fails, report it. When it failed before the worker made a model call and its pane and
  task are gone, retry it once with the same profile and model. Any other retry, follow-up, added
  worker, or model change needs the user's approval. Never switch model or provider silently.
- Aim for about 5 minutes for fast and 10 for deep. The aim is yours: put no deadline or budget in
  an assignment, never sleep or poll, and never cancel a worker only because the aim passed.
- After the report, fix findings only on the user's own work, and never after a request for a
  read-only review or "no changes". Fixing never approves a publish or absorbing unrelated changes.

## Procedure

1. Resolve the target as in [Resolve the target](phases.md#resolve-the-target).
   - After an earlier review of this target in this session whose findings were fixed: a `fix`
     target, with that review's directory as `review` and the paths of the closed findings as
     `findingPaths`. Capture the whole target instead when the user asks for a full review or the
     earlier review left no usable snapshot.
   - The ticket under review is the one the user or a calling skill names. Otherwise, only for the
     branch's own work (merge base to `HEAD` or the working tree, or uncommitted work), use the
     branch's issue from `linear issue view --json --no-pager`. With no ticket, or a failed read,
     the report stays local.

2. Prepare and capture as in [Handle the capture result](phases.md#handle-the-capture-result).
   - After the `unmatched` gaps and before the `empty` check, a `fix` capture with
     `scope: "wholeTarget"` widened the change: capture the whole target fresh.

3. Gather evidence as in [Gather evidence](phases.md#gather-evidence).

4. Run the mode, with the rules of [Run the workers](phases.md#run-the-workers).
   - Fast: one reviewer. Add "Try to disprove each finding before you report it."
   - Deep: a finder, with "Report every plausible material candidate; the checker tests them." Then
     a fresh checker, with the `## Checker` lines of the review assignment and the finder's
     candidates, or the path `$dir/finder.md` holding its report. Launch the checker even when the
     finder found nothing.

5. Call `code_review` `freshness` with `$dir`. Report `fresh` as fresh. The check is not atomic, and
   covers only the captured target, not callers or rules outside it. Label `stale` with its reasons
   and ask whether to review again. Report `unknown`, or a failed call, as unknown. Keep the
   finished results in every case.

6. Save the worker reports and `$dir/report.md` with the [report template](report.md).

7. Post `$dir/report.md` to the ticket, before any fixing. Skip this step without a ticket.
   - Call `tracker_draft` `prepare` with the ticket identifier in lower case. Find the earlier
     report with the tracker skill's comment list command: the comment with ID
     `draft.reviewCommentId`, or with none recorded, the one whose first line is
     `# Code review: <ticket>`. Read its text from that list.
   - Post without asking, as [Hard rules](../tracker/SKILL.md#hard-rules) allows, only when the work
     and the ticket are both the user's own, as the tracker skill defines a ticket. Otherwise ask
     with `ask_user_question` first, and skip the post if the user declines.
   - Update the earlier comment when one exists, and never add a second one. Otherwise add one.
     Record its ID at once, in `$dir/report.md` and by calling `tracker_draft` with action `record`,
     the ticket `id`, field `reviewCommentId`, and the comment ID as `value`.
   - If the post fails, keep the local report and say so in the reply.

8. Reply with the [report template](report.md). Name the comment URL, or say the report stays local.
   Name any Linear edits the update replaced.
   - Findings on the user's own work, without a request for a read-only review or "no changes":
     continue with the [triage-findings](../triage-findings/SKILL.md) skill without asking. Then ask
     about Blocked findings and any gap, failure, or stale result that needs a decision.
   - Any other findings: end with one question that proposes actions, such as "Fix 1 and 2, and
     investigate 3?", and includes any decision a gap or stale result needs. Act on the approved
     findings with triage-findings.
   - Without findings, ask only about a gap, failure, or stale result that needs a decision. Never
     call an incomplete or stale review clean.
