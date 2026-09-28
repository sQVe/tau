---
name: code-review
description:
  Review local code changes with fresh subagent workers. Fast by default with one self-checking
  reviewer; deep adds a fresh checker. Use it for "/code-review", "/code-review fast", "/code-review
  deep", "review my branch", "review these changes", or a review of a commit, range, or files.
  Reviews never edit, fix, commit, or publish.
---

# Code review

## When to use

Use this skill when the user asks you to review local code: the current branch, uncommitted work, a
commit or range, or named files. It needs the `subagent` tools inside herdr. Without them, tell the
user and stop.

## Goal

Report material defects, missed requirements, rule violations, and design problems in the selected
target, with the evidence status of each finding. Never call a review clean when a worker failed,
stopped early, or left a claim uncertain, or when the input changed during the review.

## Hard rules

- Read only. Do not edit source, fix findings, stage, commit, push, or publish. Do not check out,
  reset, or stash to reach a target. Stop when the user says stop.
- Mode: fast unless the user asks for deep. A request for the "full diff" names the scope, not the
  mode.
- Review the whole selected target on every run. Do not shrink a repeated review to a delta or reuse
  earlier findings or verdicts.
- Launch workers with the `reviewer` profile. Omit `model` to use the configured reviewer model,
  unless the user names a model. Omit `timeoutSeconds`, unless the user names a cheap model; then
  set a shorter one than the default. If a launch fails, report it. Never switch model or provider
  silently.
- Fast launches one worker. Deep launches two: a finder, then a fresh checker. Never retry, follow
  up, or add workers without the user's approval.
- Aim for about 5 minutes for fast and 10 for deep. The aim is yours, not the workers': put no
  deadline, countdown, or tool budget in an assignment. Do not sleep, poll, or set timers; end your
  turn to wait for notices. Do not cancel a running worker only because the aim passed.
- Include the test and probe restrictions below in every worker assignment.

## Procedure

1. Resolve the target once.
   - No target given: on the default branch, review uncommitted work from `HEAD`, including
     untracked files. On another branch, review the branch: from `git merge-base <default> HEAD` to
     the working tree, including uncommitted and untracked files. Find the default with
     `git symbolic-ref --short refs/remotes/origin/HEAD`.
   - Commit: from its parent to the commit. A root commit has no parent; capture it with
     `git show --no-ext-diff --no-color --format= <sha>`. Range: `A..B` as given. Pin both ends with
     `git rev-parse`.
   - Named files: their full contents plus their diff from `HEAD`. A named file without changes is
     still reviewed.
   - Record exclusions the user declares. Ask when the target, base, or ownership is unclear. When
     the work is the user's own, workers also list worthwhile pre-existing issues in touched code.

2. Prepare one input file. From the repository root, create a fresh review directory inside an
   ignored `.tau/`:

   ```sh
   ! [ -L .tau ] && ! [ -L .tau/workers ] && ! [ -L .tau/.gitignore ] &&
     mkdir -p .tau/workers &&
     { grep -qsx '\*' .tau/.gitignore || printf '\n*\n' >> .tau/.gitignore; } &&
     dir=$(mktemp -d .tau/workers/review-XXXXXX) &&
     git check-ignore -q "$dir/input.md" && echo "dir=$dir"
   ```

   Stop and tell the user unless it prints `dir=`. It refuses symlinks that would send writes
   outside the repository, but a path swapped between the check and the write can still escape. Use
   the printed path as `$dir` from here on.

   Write `$dir/input.md` with the target, mode, base and HEAD SHAs, declared exclusions, the rule
   files that apply (such as `AGENTS.md` and the ADRs it links), and any existing check result with
   its saved output path, or "none". Include the known task intent, acceptance criteria, and
   intentional behavior changes. Mark unavailable context explicitly; do not invent requirements or
   copy the whole conversation. End it with a `## Capture` heading. Then capture from the repository
   root, in one bash call that sets `dir` and `base`:

   ```sh
   set -o pipefail
   capture() {
     git -c diff.autoRefreshIndex=false diff --no-ext-diff --no-color "$base" &&
       git ls-files -z -o --exclude-standard | while IFS= read -r -d '' f; do
         git diff --no-ext-diff --no-color --no-index -- /dev/null "$f"
         [ $? -le 1 ] || echo "CAPTURE ERROR: $f" >&2
       done
   }
   capture > "$dir/capture.diff" 2> "$dir/capture.err"; echo "exit $?"
   ```

   - Stop and tell the user when the exit status is not 0, or when `capture.err` has any message
     that is not about a file you confirm is unreadable with `[ -r <file> ]`. List each confirmed
     unreadable file as a gap. Exit 1 from `--no-index` is normal.
   - Only then run `git hash-object "$dir/capture.diff"`, keep the hash for the freshness check,
     append the file to `input.md`, and delete it. The `diff --git` headers list the changed paths.
   - The capture does not change staged contents or write Git objects. `diff.autoRefreshIndex=false`
     stops `git diff` from rewriting the cached file metadata in `.git/index`.
   - Scope the commands with `-- <paths>` for named files, and `':(exclude)<path>'` for exclusions.
     For named files, loop over `git ls-files -z -c -o --exclude-standard -- <paths>` so unchanged
     files appear in full. A named path that lists nothing is a gap; ask about it.
   - For a commit or range, capture only `git diff --no-ext-diff --no-color "$from" "$to"`, without
     the untracked loop. For a root commit, capture only the `git show` command from step 1.
   - An empty capture with no errors means there is nothing to review. Say so and stop.
   - List binary files, exclusions, and unreadable files under a `## Gaps` heading at the end of
     `input.md`. Never trim the capture.

3. Run the mode.
   - Fast: launch one reviewer with the review assignment below. Add "Try to disprove each finding
     before you report it."
   - Deep: launch a finder with the review assignment, adding "Report every plausible material
     candidate; the checker tests them." When it reports, launch a fresh checker with the checker
     assignment and the finder's candidates, or save the finder's report to `$dir/finder.md` and
     pass that path. Launch the checker even when the finder completed with no candidates.
   - Before you launch more work, check the elapsed time. If the aim has already passed, show the
     findings you have, labelled with their status, and ask whether to continue.
   - If a worker fails or stops without a report, do not relaunch it. Show any notes it left as
     unverified leads and report the review as incomplete.
   - Always report finished results, even after the aim has passed.

4. Check freshness. Run the same capture into `$dir/recheck.diff` with errors in `$dir/recheck.err`,
   never into `input.md` or `capture.err`. Apply the same checks. Only when they pass, compare
   `git hash-object "$dir/recheck.diff"` and `git rev-parse HEAD` with the start. If the checks
   fail, report the freshness as unknown. If either value differs, label the review stale and ask
   whether to run a new one. The check is not atomic and covers only the captured target, not
   callers or rules outside it.

## Review assignment

- Run tests or probes only in a trusted project, and only when a result decides a claim. Reuse a
  matching existing result instead of rerunning it.
- Read `$dir/input.md` in full, continuing with offsets. Commits are pinned: read their files with
  `git show <sha>:<path>`, not from the working tree.
- Review by risk across the whole target: the changed hunks and enclosing code, affected callers and
  contracts, the bodies of relevant tests, and material project rules and design. Follow real risk
  beyond the target. Do not audit unrelated code.
- Report only material findings: a concrete failure or cost, file:line evidence, and a fix
  direction. For rule violations, also cite the applicable rule's file and supporting lines. No
  quotas or nits. Mark pre-existing issues separately. Name areas you left unread or read only
  shallowly.
- Save details that do not fit the report in `$dir/details.md`.
- Handoff: "Changes: None, read-only. Baseline: `$dir/input.md` at HEAD `<sha>`." Do not recapture
  Git state or run full checks for the handoff.

## Checker assignment

Use the review assignment, then add:

- First check each finder candidate against source, guards, callers, and tests. Give supported,
  refuted, or uncertain, with a rationale.
- Then look for omissions in the changed behavior and its relevant tests. Label anything new as
  found by the checker.

## Report

- Save each worker report in `$dir`: `reviewer.md`, or `finder.md` and `checker.md`. Write
  `$dir/report.md` with the base and HEAD SHAs, the capture hash, the source of any check result,
  every finding in full, and refuted candidates with the checker's reason.
- Header: the target, mode, elapsed time when you observed it, freshness (fresh, stale, or unknown),
  and a link to `$dir/report.md`. State once how findings were checked: fast has one self-checking
  reviewer, so no finding is independently checked; deep has a finder and a fresh checker.
- Findings: one table, most severe first, with the columns `#`, `Problem and impact`, `Evidence`,
  and `Recommendation`. Keep cells short. Put longer `file:line` evidence and fix directions in
  numbered notes after the table.
  - Evidence: the actual `file:line` and the decisive fact, such as a caller, guard, test, or
    reproduction. In deep mode, add the status: supported, disputed (the checker refuted it but it
    stays plausible), uncertain, or checker-new (not independently checked).
  - Recommendation: fix, investigate, or defer, with a reason drawn from the evidence and the cost
    of acting. Add a bounded fix direction or the question to investigate. A real issue does not
    always need a fix.
- Status says how a finding was checked, not how strong its evidence is. Decisive evidence, such as
  a reproduction, can justify a fix for a checker-new finding. Do not rank confidence or give
  scores. Your agreement does not change a status; if you read source to reach a recommendation, say
  what you read.
- Do not redo the review. Keep every material plausible or disputed finding in the table. Remove
  only exact duplicates and style points no rule supports, naming each in one line. Show refuted
  candidates only when one affects a decision. The checker's verdict is advice, not proof.
- Gaps: after the table, list exclusions, unreadable or binary input, areas workers say they left
  unread or read shallowly, worker failures, stale or unknown freshness, and a check result that may
  not match the capture. Do not infer read coverage from citations.
- End with one question. With findings, ask for approval of the proposed actions, such as "Fix 1 and
  2, and investigate 3?" Approval starts separate work after the review. When a gap, failure, or
  stale result needs a decision, include it in the question.
- With no findings from a complete, fresh run, show no table and no fix question. Say the workers
  found no material issues in the target. That covers the scope they read; it does not prove the
  change correct. An incomplete or stale review is never clean.
