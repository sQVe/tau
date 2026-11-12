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
named files. It needs the `subagent` tools. Without them, tell the user and stop.

## Hard rules

- Until the report is saved, change nothing: no edits, fixes, stages, commits, pushes, publishes,
  checkouts, resets, or stashes. The one outside write is the report comment of step 7, made with
  `ticket` `comment` under the [tracker skill](../tracker/SKILL.md)'s
  [Hard rules](../tracker/SKILL.md#hard-rules). Stop when the user says stop.
- Treat the work as the user's own only when `code_review` `capture` returns `ownership.status` as
  `own`. Do not infer ownership from the checkout or compare authors yourself.
- When `ownership.status` is not `own`, include `ownership.reasons` in the report's evidence gaps.
- Mode: fast unless the user asks for deep. "Full diff" names the scope, not the mode. Fast launches
  one reviewer. Deep launches a finder, then a fresh checker.
- A first review covers the whole target. A fix review covers only the fix diff, its callers, and
  the findings it closes. Never reuse earlier findings or verdicts.
- Launch the fast reviewer and the deep finder with the `reviewer` profile, and the deep checker
  with the `checker` profile. Give each the [review assignment](review-assignment.md). Omit `model`
  unless the user names one. Omit `timeoutSeconds` unless the user names a cheap model; then set a
  shorter one.
- If a launch fails, report it. When it failed before the worker made a model call and its pane and
  task are gone, retry it once with the same profile and model. Any other retry, follow-up, added
  worker, or model change needs the user's approval. Never switch model or provider silently.
- Aim for about 5 minutes for fast and 10 for deep. Give the fast reviewer the budget in the review
  assignment. Put no deadline or budget in a deep assignment. Never sleep or poll, and never cancel
  a worker only because the aim passed.
- After the report, fix findings only on the user's own work, and never after a request for a
  read-only review or "no changes". Fixing never approves a publish or absorbing unrelated changes.

## Procedure

1. Resolve the target as in [Resolve the target](phases.md#resolve-the-target).
   - After an earlier review of this target in this session whose findings were fixed: a `fix`
     target. Its `review` is the newest completed review in this target's chain: the first review or
     an earlier fix review, never an older link. Its `findingPaths` are the paths of the closed
     findings. Capture the whole target instead when the user asks to review the whole target or the
     earlier review left no usable snapshot.
   - Otherwise, when you or a calling skill review one ticket's work on a longer branch, such as one
     agent ticket, target only that work: a `range` of its commits, or a `workingTree` from the
     commit before it when the work is uncommitted. Never fall back to the merge base, which reads
     earlier tickets again.
   - The ticket under review is the one the user or a calling skill names. Otherwise, only for the
     branch's own work (merge base to `HEAD` or the working tree, or uncommitted work), use the
     branch's issue from `linear issue view --json --no-pager`. With no ticket, or a failed read,
     the report stays local.

2. Prepare and capture as in [Handle the capture result](phases.md#handle-the-capture-result).
   - After the `unmatched` gaps and before the `empty` check, a `fix` capture with
     `scope: "wholeTarget"` widened the change: capture the whole target fresh.
   - Keep the capture result's `identity` for `report.md`.

3. Gather evidence as in [Gather evidence](phases.md#gather-evidence). Include the applicable
   policy, design records, and affected callers needed by
   [decision evidence](../shared/decision-evidence.md). Record missing sources as gaps, including
   when there is no ticket.

4. Run the mode, with the rules of [Run the workers](phases.md#run-the-workers).
   - Fast: one reviewer, with the fast budget of the review assignment. Add "Try to disprove each
     finding before you report it."
   - Deep: a finder, with "Report every plausible material candidate; the checker tests them." Then
     a fresh `checker` worker, with the `## Checker` lines of the review assignment and the finder's
     candidates, or the path `$dir/finder.md` holding its report. Launch the checker even when the
     finder found nothing.

5. Call `code_review` `freshness` with `$dir`. Report `fresh` as fresh. The check is not atomic, and
   covers only the captured target, not callers or rules outside it. When `stale` has only a HEAD
   move as its reason, with the same capture `hash`, report it as stale with that reason and say
   that content coverage is checked at the PR step. Do not ask to review again for that case. Label
   any other `stale` with its reasons and ask whether to review again. Report `unknown`, or a failed
   call, as unknown. Keep the finished results in every case.

6. Save the worker reports and `$dir/report.md` with the [report template](report.md). Apply the
   [decision evidence recheck rules](../shared/decision-evidence.md#reuse-and-recheck) to relevant
   sources outside the capture too; tool freshness alone does not check them.

7. Post `$dir/report.md` to the ticket, before any fixing. Skip this step without a ticket.
   - When the work is not the user's own, ask with `ask_user_question` before posting and skip the
     post if declined. On the user's own work, do not ask separately. The tool confirms for another
     person's ticket under [Hard rules](../tracker/SKILL.md#hard-rules).
   - Call `ticket` `comment` once with the ticket, heading `# Code review: <ticket>`, and
     `bodyFile: "$dir/report.md"`. Ensure the report's first line matches the heading.
   - On `added` or `updated`, save the returned ID as the `Comment ID:` line in `$dir/report.md`.
     Use `previousBody` to name any Linear edits the update replaced.
   - On `declined` or failure, keep the local report and say it was not posted.

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
