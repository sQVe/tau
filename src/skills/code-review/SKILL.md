---
name: code-review
description:
  Review local code changes with fresh subagent workers. Fast by default with one self-checking
  reviewer; deep adds a fresh checker. Use it for "/code-review", "/code-review fast", "/code-review
  deep", "review my branch", "review these changes", or a review of a commit, range, or files. The
  review never edits, fixes, commits, or pushes. Its outside writes are the report comment on the
  reviewed ticket, posted as the tracker skill's rule allows, and, when the user asks to comment on
  another person's PR, the pending review of [post review](post-review.md) under the same rule. On
  the user's own work, it then fixes the supported findings with triage-findings, unless the user
  asked for a read-only review.
---

# Code review

## When to use

Use this skill to review local code: the current branch, uncommitted work, a commit or range, or
named files. It needs the `subagent` tools. Without them, tell the user and stop.

## Hard rules

- Until the report is saved, change nothing: no edits, fixes, stages, commits, pushes, publishes,
  checkouts, resets, or stashes. The outside writes are the report comment of step 7, made with
  `ticket` `comment`, and the pending review of [post review](post-review.md), made only on the
  user's request, both under the [tracker skill](../tracker/SKILL.md)'s
  [Hard rules](../tracker/SKILL.md#hard-rules). Stop when the user says stop.
- Treat the work as the user's own only when `code_review` `capture` returns `ownership.status` as
  `own`. Do not infer ownership from the checkout or compare authors yourself.
- When `ownership.status` is not `own`, include `ownership.reasons` in the report's evidence gaps.
- Mode: fast unless the user asks for deep. "Full diff" names the scope, not the mode. Fast launches
  one reviewer. Deep launches a finder, then a fresh checker.
- A first review covers the whole target. A fix review covers only the fix diff, its callers, and
  the findings it closes. Never reuse earlier findings or verdicts as fix-review results.
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
- After the report, act on findings without asking only on the user's own work. Respect requests for
  a read-only review or "no changes". Approval to act never approves a publish or unrelated changes.

## Procedure

1. Resolve the target as in [Resolve the target](phases.md#resolve-the-target).
   - For the lead's one fix review, keep the first review's directory. Keep it even when the batch
     made no change or the capture falls back to the whole target.
   - After the lead's first-review batch, or after fixing findings from another review of this
     target in this session: a `fix` target. Its `review` is the newest completed review in this
     target's chain: the first review or an earlier fix review, never an older link. Its
     `findingPaths` are the paths of the closed findings. Capture the whole target instead when the
     user asks to review the whole target or the earlier review left no usable snapshot.
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
   - After the lead's first-review batch, an empty fix capture with no gaps and the expected base
     and HEAD means there is no fix diff to review. State that result. Skip the report and comment
     steps. Continue at the read-only guard in step 8 with the first review's report and no new
     findings. Use ownership from the fix capture. Do not start a reviewer or claim the earlier
     findings are closed. Use the shared capture rules for all other cases.
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

7. Post `$dir/report.md` to the ticket, before any fixing. Skip this step without a ticket. Skip the
   post if the user's request prohibits outside writes.
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
   - For a read-only review or "no changes", report the findings without acting on them. Act only if
     the user approves changing that scope.
   - When the lead will batch first-review fixes under its worker-run guideline, return the findings
     to the lead for that batch instead of starting triage here.
   - After the lead's one fix review, start [triage-findings](../triage-findings/SKILL.md) once in
     its post-fix phase. Give it the new findings and the first-review findings that the batch did
     not settle. Include their report references. Do this even if the fix review has no findings.
     Leave out earlier findings only when current evidence supports their closure, such as a checked
     fix or a supported dismissal. A worker's claim alone does not settle a finding. Leave approval
     and action selection to triage.
   - For findings on the user's own work in other reviews, continue with
     [triage-findings](../triage-findings/SKILL.md) without asking. That skill owns the disposition
     questions.
   - For other findings on work that is not the user's own, ask which actions to take. Use triage
     only for the actions the user approves. When the user asks to comment on the PR, follow
     [post review](post-review.md).
   - Ask about a gap, failure, or stale result only when it needs a decision. Never call an
     incomplete or stale review clean.
