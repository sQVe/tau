---
name: pr
description:
  Create or update the GitHub pull request for the current branch. Prepares commits and release
  notes, checks comments, reuses or runs review and checks, and previews publication for approval.
  Use it for "open a PR", "create a pull request", "update the PR", or "mark the PR ready".
metadata:
  required-for:
    creating, updating, or marking ready a pull request, including as a step in a larger task
---

# Pull request

## When to use

Use this skill for the branch in this session's worktree. It needs `gh` authenticated for the target
host's active account.

## Goal

Publish a PR that matches the approved preview and the pushed commits. Mark it ready only when step
6 finds no gap.

## Hard rules

- Push, create or edit a PR, or change its draft status only after the user approves the preview.
  Any change after approval needs a new preview.
- Ask every question with `ask_user_question`, including review approval and preview approval. Never
  ask in prose.
- Follow the push rules in the [update-branch skill](../update-branch/SKILL.md). Never force-push
  unless the user asks or approves a preview that shows the force-push. Step 5 restacks locally;
  preview approval covers the stack's force-push. Outside a stack, rebase only as step 1 allows or
  when the user asks.
- Commit with the [commit skill](../commit/SKILL.md). Never stash, discard, or commit unrelated
  changes. Ask when ownership is unclear or unrelated changes could affect review or checks.
- On the user's own PR or branch, as the [code-review skill](../code-review/SKILL.md) defines it,
  fix supported, in-scope review findings and the in-scope causes of failing checks without asking,
  unless the user asked for a read-only review or no changes. On anyone else's, fix only with the
  user's approval. Never weaken a check or add a retry to hide a failure.
- On updates, keep title and body text you did not write this session. Change only wrong or missing
  facts, and preview each change.
- After a partial failure, stop and report what completed. Read the remote branch and PR before
  retrying.
- Do not watch CI, wait for reviews, request human reviewers, or merge.
- Before saving any file, call the `pr` tool's `prepare` action. Stop if it fails. Use the returned
  directory as `$prdir` for every saved file. Never use `/tmp` or another shared path: other
  sessions run at the same time.

## Procedure

1. Run the stack check of the [stack skill](../stack/SKILL.md) on the branch. Stop as it says for an
   untracked or unknown result. For a tracked branch, note its parent. When the user names a base
   that differs from that parent, stop and ask: changing the base of a stacked PR changes the stack,
   which the stack skill must do first.

   Then gather publication evidence with one read-only `codemode` script for both creates and
   updates. Start it with `// @options: {"max_output_tokens": 4000}`. Filter before printing, print
   strings as plain lines rather than result objects, and keep the output within that limit.
   - Call the `pr` tool's `evidence` action. Pass the user-named remote as `remote`, when given.
     Pass the stack parent for a tracked branch, otherwise the user-named base, as `base`. It wins
     over an open PR's base, so the target and merge base follow the stack. Pass the newest
     `.tau/workers/review-*` directory saved for this branch as `review`, when one exists. Use saved
     review input or session evidence to check its branch; report unclear ownership as a gap rather
     than guessing.
   - The result has `target`, `branch`, `subjects`, `reuse`, `review`, `checks`, and `gaps`.
     Unavailable objects are null. In the same script, find ticket IDs in the user's links,
     `branch`, commit `subjects`, and `target.pr.body`. Read each distinct ticket with its service's
     CLI, such as `linear issue view <id> --json --no-pager --no-download`. Use returned issue IDs,
     not branch aliases. Keep only each ticket's title and `## Acceptance` section as intent.
   - Print the target's head, base, merge base, repository, open PR fields, and closed PRs; ticket
     intent; reuse status, reasons, and available reports; review freshness and evidence gaps; and
     matching check-log paths with their bounded excerpts. Print one combined list of gaps from the
     tool, failed or skipped reads, missing ticket intent, and anything omitted to fit the limit. A
     check with `matches: true` has matching inputs, not a passing result. Read the log's result
     before judging it; read omitted evidence through its returned path when needed.
   - The script gathers evidence only. It never calls `prepare` or `verify`, and writes nothing
     itself. The evidence action fetches the base and may write the review reader's freshness
     recapture. Target questions, rebases, review runs, previews, and approvals stay outside it.
   - If `target` is null because no head remote or several were found, ask which remote to use and
     rerun the script. On any other target error or a failed evidence call, tell the user and stop.
   - Use `target.repository` as `--repo <repo>` for repository-scoped `gh` commands, `target.head`
     for the push remote and branch, and `target.mergeBase` as the merge base.
   - Use the open PR in `target.pr`. If it is null and `target.closedPrs` lists merged or closed
     PRs, ask before continuing. When its `baseRefName` differs from `target.base.branch`, step 9
     changes the PR's base.
   - Outside a stack, when the branch conflicts with the base or needs a base change for its checks,
     rebase it locally with the update-branch skill and tell the user. Do not ask to approve the
     rebase, even when the branch was already pushed. The update-branch question about a dirty
     working tree still applies. Note the remote tip before the rebase as `<old-tip>`; step 8
     previews the force-push it needs. Stop the rebase and ask when a conflict needs a product
     decision. Rerun the evidence script after the rebase to pin the new merge base.

2. Commit the task's changes and required release notes, such as a `.changeset` file. List unrelated
   changes in the session report.

3. Check comments added since the merge base yourself. This does not block the PR.
   - Read each file using its language's comment syntax, including whole block and doc comments.
     Quote each comment exactly with `file:line`.
   - Apply "Comment only what the code cannot say" in the
     [coding instructions](../../instructions/coding.md), or the repository's comment rules.
   - Remove only failing comments and commit the removal. Report each removal in the session report,
     not the PR body. Repeat for comments added by later commits before previewing.

4. Review `<merge base>..HEAD`, with both ends pinned. Rerun step 1's evidence script if the branch
   or saved evidence changed since collection. Reuse an earlier review only if:
   - The session or saved `.tau/workers/review-*/` files show every worker reported (`reviewer.md`,
     or `finder.md` and `checker.md`), freshness passed, and no gaps remain besides areas a worker
     read shallowly. Unstated status is unknown; do not reuse it.
   - It covered the whole branch, not only some of its commits.
   - The script's `reuse.status` is `match` for that review and the current merge base.
   - The script's review freshness passed. A changed head or stale capture blocks reuse, even when
     the branch diff matches. A missing or unknown result is not a pass.
   - Callers and rules outside the capture have no relevant changes.

   Otherwise run the [code-review skill](../code-review/SKILL.md) in fast mode on the range. If the
   skill or worker tools are missing, report a gap; do not review in their place. On the user's own
   PR or branch, let it continue into the [triage-findings skill](../triage-findings/SKILL.md),
   which commits its fixes with the commit skill. On anyone else's, ask its approval question.

5. Run checks. Reuse a required pre-merge check only when the evidence script lists its log as
   matching and reading its result shows it passed. Otherwise run it once on the committed tree.
   - In a stack, first restack branches above with the stack skill. Check the PR's branch and every
     branch above changed by restacking, because step 9 pushes them all. After later commits,
     restack and rerun affected checks before previewing.
   - Save real output, never a summary, as `$prdir/checks/<name>.log`. Create `checks` under the
     prepared directory. Before the run, call the `pr` tool's `checkHeader` action with the pinned
     merge base as `mergeBase`. Write its returned lines at the top of the log, then append the
     check's output and exit status. Stop if the action fails.

   - Rerun the evidence script before reusing saved checks. A match only binds the recorded inputs;
     it does not prove success or detect every edit to an already dirty file. Rerun affected checks
     after relevant changes, even if their headers still match.

6. Choose draft status. Any gap means draft. A gap is one of:
   - A required check that failed or did not run. Only checks that can run solely after deployment
     are deferred instead of gaps.
   - A review that does not cover the pushed content. A checked fix counts as covered: it changes
     only what its finding or failing check needs, and the checks that cover it passed after it.
   - An open finding. A finding closes when its fix is checked as above or reviewed again, or when
     the user dismisses it as not a defect. Record the dismissal reason in the session report.
     Deferred, Blocked, or unfixed findings stay open.

   Areas a worker read shallowly are session-report notes, not gaps. Accept checked fixes without
   asking, and list them in the session report. If other post-review commits make review coverage
   the only gap, such as a fix that changes behavior beyond its finding, ask once: run a new fast
   review or open as draft. Run a new review when the user asks for one. After a new review, choose
   status again. For an existing ready PR with a gap, offer conversion to draft.

7. Write the title and body. Save the body as `$prdir/body.md`.
   - Template: for a new PR or a body not following the template, find `pull_request_template.md`
     case-insensitively in the root, `.github/`, `docs/`, or a `PULL_REQUEST_TEMPLATE/` directory.
     When several fit, use the repository's clear default and name it in the preview; ask when they
     imply different requirements. Without one, use the [fallback template](fallback-template.md).
     Keep text you did not write this session. Show any restructuring it needs in the preview.
   - Title: match the repository's convention.
   - Summary: lead with one sentence on what changes, then at most three on why and what the diff
     cannot show: external causes, constraints, or rejected approaches. Do not repeat the diff or
     commit messages. Give each unrelated change one line.
   - Verification: put the review result, open findings, fixes accepted without review, checks that
     ran, untested areas, and known gaps in the template's verification section, such as Validation,
     Testing, or How to test. Keep that section even if optional for low-risk changes. Keep this
     evidence out of the summary. Only if no verification section exists, put it after the summary.
     Give each check one line, and describe its setup only when a reviewer must repeat it.
   - Issues: link Linear tickets as the [tracker skill](../tracker/SKILL.md) says. For other issues,
     use `Fixes <issue>` only for issues this PR completes; use `Related to <issue>` for others.
   - Format: write full commit SHAs as plain text, never in backticks. Keep reviewer notes, worker
     names, and local paths in the session report.

8. Preview and ask for approval. Show title, full body, base repository and branch, head, draft
   status, commits to push, and push command.
   - After a rebase in step 1 of a branch with a remote tip, say that the push is a force-push and
     show it with `--force-with-lease=refs/heads/<branch>:<old-tip>`.
   - For an existing PR whose base changes, show the current base and the new one.
   - In a stack, list each branch to push with its local SHA and explain that each is force-pushed
     with a lease. Show the `gh stack link` command, or why step 9 cannot link.
   - Include the session report: commits made, comment removals, review and check sources, reviewer
     notes, dismissed findings with their reasons, and gaps.

9. Publish.
   - Compare HEAD, local status, and commits to push with the preview; read the PR again. In a
     stack, compare each branch's SHA too. If anything changed, stop, refresh affected evidence, and
     preview again without losing new edits.
   - Push with `git push <remote> HEAD:refs/heads/<branch>`; add `-u` for a new branch. After a
     rebase in step 1, push with the previewed `--force-with-lease` command instead. In a stack, use
     the stack skill instead. Stop and report a rejected push.
   - Create with `gh pr create`: specify approved base, head, title, and `--body-file`. Add
     `--draft` for approved draft status and `--head <owner>:<branch>` for a fork. Update with
     `gh pr edit`, adding `--base <base>` when the base changes. Change existing draft status with
     `gh pr ready`, adding `--undo` for draft.
   - After creating a stacked PR, or updating one that no GitHub stack holds, link it into a GitHub
     stack. Never use `gh stack submit`, which publishes generated titles instead of approved ones.
     If this PR is not the local stack's top, do not link; report GitHub's top-only limit.
   - Read the GitHub stack holding the PR below with
     `gh api --hostname <host> "repos/<owner>/<name>/stacks?pull_request=<number>" --jq '.[0] // {} | {number, pullRequests: ((.pull_requests // []) | map(.number))}'`.
   - When `number` is set, check that the last entry of `pullRequests` is the PR below. If it is
     not, stop and report before you link: link would base this PR on that other top PR. Otherwise
     append with `gh stack link --remote <remote> <stack number> <this PR>`. It skips PRs already in
     the stack and bases this PR on the branch of the stack's top PR.
   - When `number` is null, link with
     `gh stack link --remote <remote> --base <trunk> <open PR numbers, bottom to top>`, taken from
     `gh stack view --json`. Keep `--base`; omitting it sets the bottom PR's base to the default
     branch. Pass only open PRs: link moves each PR onto the branch of the PR before it, so a merged
     PR would pull the PR above it back onto the merged branch. One open PR needs no link.
   - After a link, read the remote stack again using this PR's number. Check that it lists this PR
     at the top and that each open PR's base is the branch of the open PR below it, or the trunk.
     `gh stack view --json` reads only the local stack and cannot confirm linking.

10. Check the published PR with the `pr` tool's `verify` action. Pass `$prdir` and the approved
    repository, PR number, title, base, and draft status. Stop if the call fails or shows a
    difference, and report each difference. Otherwise report the PR URL, then stop.
