---
name: code-review
description:
  Review local code changes with fresh subagent workers. Fast by default with one self-checking
  reviewer; deep adds a fresh checker. Use it for "/code-review", "/code-review fast", "/code-review
  deep", "review my branch", "review these changes", or a review of a commit, range, or files. The
  review never edits, fixes, commits, or publishes. On the user's own work, it then fixes the
  supported findings with triage-findings, unless the user asked for a read-only review.
---

# Code review

## When to use

Use this skill when the user asks you to review local code: the current branch, uncommitted work, a
commit or range, or named files. It needs the `subagent` tools inside herdr. Without them, tell the
user and stop.

## Goal

Report material defects, missed requirements, rule violations, and design problems in the selected
target. Give each finding a status that says how it was checked.

## Hard rules

- The review is read-only. Until the report is written, do not edit source, fix findings, stage,
  commit, push, or publish. Do not check out, reset, or stash to reach a target. Stop when the user
  says stop.
- Decide ownership from the branch, never from the checkout alone: the user often checks out other
  people's PRs. The branch is the user's own when its PR author is the
  `gh api user --hostname <host> --jq .login` login, using the PR's host, or, with no PR, when each
  of its commits has the author email `git config user.email`. A branch with no commits of its own
  counts when nothing points to another author. Uncommitted work is the user's own only on a branch
  these rules find to be the user's own. Anything else, or anything unclear, is not the user's own.
- After the report, fix findings automatically only on the user's own work, and never after a
  request for a read-only review or "no changes". Fixing is never approval to publish, post, or
  absorb unrelated changes.
- Mode: fast unless the user asks for deep. A request for the "full diff" names the scope, not the
  mode. Fast launches one reviewer. Deep launches two: a finder, then a fresh checker.
- Review the whole target on every run. Do not shrink a repeated review to a delta or reuse earlier
  findings or verdicts.
- Launch workers with the `reviewer` profile. Omit `model` to use the configured reviewer model,
  unless the user names a model. Omit `timeoutSeconds`, unless the user names a cheap model; then
  set a shorter one than the default.
- If a launch fails, report it. Never switch model or provider silently. When a launch failed before
  the worker made a model call, and you confirmed its pane and task are gone, retry it once with the
  same profile and model. Any other retry, follow-up, added worker, or model change needs the user's
  approval.
- Aim for about 5 minutes for fast and 10 for deep. The aim is yours, not the workers': put no
  deadline, countdown, or tool budget in an assignment. Do not sleep, poll, or set timers; end your
  turn to wait for notices. Do not cancel a running worker only because the aim passed.
- Give every worker the test and probe rules from the [review assignment](review-assignment.md).

## Procedure

1. Resolve the target once, as a `code_review` capture target. Pin every revision you pass with
   `git rev-parse`.
   - No target given: on the default branch, review uncommitted work from `HEAD`, including
     untracked files, as a `workingTree` target. On another branch, review the branch: a
     `workingTree` target from `git merge-base <default> HEAD`, which includes uncommitted and
     untracked files. Find the default with `git symbolic-ref --short refs/remotes/origin/HEAD`.
   - Commit: a `range` from its parent to the commit. A root commit has no parent; use a
     `rootCommit` target. Range: a `range` target for `A..B` as given.
   - Named files: a `files` target, which captures their full contents plus their diff from `HEAD`.
     A named file without changes is still reviewed.
   - Record exclusions the user declares, and pass them as `exclude`. Ask when the target, base, or
     ownership is unclear. When the work is the user's own, workers also list worthwhile
     pre-existing issues in touched code.

2. Call `code_review` with `prepare`. If it fails, stop and tell the user. Use the returned
   directory as `$dir` from here on.

3. Write `$dir/input.md` with the [input template](input.md).

4. Call `code_review` with `capture`, `$dir`, and the target from step 1.
   - If the call fails, stop and tell the user what it reports.
   - Before anything else, ask the user about each `unmatched` gap. List every gap in the report.
   - If `empty` is true, there is nothing to review. Say so and stop.
   - If `head` or `base` differs from the SHAs in `input.md`, the target moved while you wrote it.
     Start again from step 1.
   - Keep `hash` for the report. Never edit or trim the capture in `input.md`.

5. Run the mode.
   - Fast: launch one reviewer with the [review assignment](review-assignment.md). Add "Try to
     disprove each finding before you report it."
   - Deep: launch a finder with the review assignment, adding "Report every plausible material
     candidate; the checker tests them." When it reports, launch a fresh checker with the
     [checker assignment](checker-assignment.md). Pass it the finder's candidates, or save the
     finder's report to `$dir/finder.md` and pass that path. Launch the checker even when the finder
     found no candidates.
   - Before you launch more work, check the elapsed time. If the aim has passed, show the findings
     you have with their status, and ask whether to continue.
   - Apart from the one launch retry the hard rules allow, do not relaunch a worker that fails or
     stops without a report. Show any notes it left as unverified leads and report the review as
     incomplete.
   - Always report finished results, even after the aim has passed.

6. Call `code_review` with `freshness` and `$dir`.
   - `fresh`: report the review as fresh.
   - `stale`: label the review stale, give the reasons, and ask whether to run a new one.
   - `unknown`, or a failed call: report the freshness as unknown, with the reasons or the error.
     Still save and report the finished results.
   - The check is not atomic. It covers only the captured target, not callers or rules outside it.

7. Save the files and reply to the user with the [report template](report.md).
   - With findings on the user's own work, unless the user asked for a read-only review or "no
     changes", continue without asking: act on them with the
     [triage-findings](../triage-findings/SKILL.md) skill. Ask afterward about findings it leaves
     Blocked and about a gap, failure, or stale result that needs a decision.
   - Otherwise end with one question. With findings, ask for approval of the proposed actions, such
     as "Fix 1 and 2, and investigate 3?" When a gap, failure, or stale result needs a decision,
     include it in the question. Act on the approved findings with the triage-findings skill.
   - With no findings from a complete, fresh run, ask no fix question.
   - Never call an incomplete or stale review clean: a worker failed, stopped early, or left a claim
     uncertain, or the input changed during the review.
