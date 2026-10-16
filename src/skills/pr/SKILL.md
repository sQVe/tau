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

Use this skill for the branch in this session's worktree.

## Goal

Publish a PR that matches the approved preview and the pushed commits, with the draft status the
user chose. Step 6 suggests a status; the user may publish as ready while gaps are open.

## Hard rules

- Push, create or edit a PR, or change its draft status only after the user approves the preview. A
  change after approval needs a new preview, unless the approved option or the user's answer already
  named that exact change and you apply it as stated.
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
  directory as `$prdir` for every saved file. Never use `/tmp` or another shared path.

## Procedure

1. Call the `stack` tool's `check` action on the branch. Stop as the
   [stack skill](../stack/SKILL.md) says for an untracked or unknown result. For a tracked branch,
   note its `parent`. When the user names a base that differs from that parent, stop and ask:
   changing the base of a stacked PR changes the stack, which the stack skill must do first.

   Then gather publication evidence with one read-only `codemode` script for both creates and
   updates. Start it with `// @options: {"max_output_tokens": 4000}`.
   - Call the `pr` tool's `evidence` action. Pass the user-named remote as `remote`, when given.
     Pass the stack parent for a tracked branch, otherwise the user-named base, as `base`. It wins
     over an open PR's base, so the target and merge base follow the stack. Pass the newest
     `.tau/workers/review-*` directory saved for this branch as `review`, when one exists. Check
     that the review directory belongs to this branch, from its saved input or session evidence.
     Report unclear ownership as a gap.
   - In the same script, find ticket IDs in the user's links, `branch`, commit `subjects`, and
     `target.pr.body`. Read each distinct ticket with its service's CLI, such as
     `linear issue view <id> --json --no-pager --no-download`. Use returned issue IDs, not branch
     aliases. Keep only each ticket's title and `## Acceptance` section as intent.
   - For a slice ticket found this way, also read its audit comment with
     `linear issue comment list <slice> --json --no-pager`. The audit is the comment whose first
     line is `# Slice audit: <slice>`, the filled first line of the
     [audit template](../finish-slice/audit.md). Print its audited commit and rows.
   - After the script, when a slice ticket has no audit comment, or its audited commit differs from
     `HEAD`, ask with `ask_user_question`: run a new audit with the
     [finish-slice skill](../finish-slice/SKILL.md), recommended, or continue with the missing or
     old audit as a gap.
   - Print the target's head, base, merge base, repository, open PR fields, and closed PRs; ticket
     intent; reuse status, reasons, and available reports; review freshness and evidence gaps; and
     matching check-log paths with their bounded excerpts. Print one combined list of gaps from the
     tool, failed or skipped reads, missing ticket intent, and anything omitted to fit the limit.
     Read omitted evidence through its returned path when needed.
   - The script gathers evidence only. It never calls `prepare` or `verify`, and writes nothing
     itself. Target questions, rebases, review runs, previews, and approvals stay outside it.
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
     or `finder.md` and `checker.md`), and no gaps remain besides areas a worker read shallowly.
     Unstated status is unknown; do not reuse it.
   - The script's `reuse.status` is `match` for that review and the current merge base.
   - The script's review freshness passed. A changed head or stale capture blocks reuse, even when
     the branch diff matches. A missing or unknown result is not a pass.
   - Callers and rules outside the capture have no relevant changes.

   Otherwise run the [code-review skill](../code-review/SKILL.md) in fast mode on the range. If the
   skill or worker tools are missing, report a gap; do not review in their place. Follow that
   skill's ownership, fix, and approval flow.

5. Run checks. Rerun the evidence script first. Reuse a required pre-merge check only when the
   script lists its log as matching and reading its result shows it passed. A match does not detect
   every edit to an already dirty file. Otherwise run it once on the committed tree. Rerun affected
   checks after relevant changes, even if their headers still match.
   - In a stack, first restack branches above with the stack skill. Check the PR's branch and every
     branch above changed by restacking, because step 9 pushes them all. After later commits,
     restack and rerun affected checks before previewing.
   - Save real output, never a summary, as `$prdir/checks/<name>.log`. Before the run, call the `pr`
     tool's `checkHeader` action with the pinned merge base as `mergeBase`. Write its returned lines
     at the top of the log, then append the check's output and exit status. Stop if the action
     fails.
   - When the repository has a configured full check, run it with the `full_check` tool, passing the
     pinned merge base as `base`. Append the log it returns after the header lines. The tool returns
     a saved passing log without a run when the head, base, command, and changes are unchanged.
   - When the change has user-visible behavior, also send it to a `qa` worker on the committed tree
     before the preview.
   - Leave the app URL, test account, and data writes to Tau, which fills them from the user's
     config. Ask the user nothing about them in advance.
   - When the QA worker asks a blocking question, pass it to the user.
   - Record what QA tested and found for step 6 and the preview.

6. Suggest a draft status. Any gap makes draft the suggested status; otherwise suggest ready. A gap
   is one of:
   - A required check that failed or did not run. Only checks that can run solely after deployment
     are deferred instead of gaps.
   - An audit item with the verdict not run. It closes when it names a check that step 5 ran and
     that check passed. A not-met item stops the flow before publication. A deferred item is not a
     gap.
   - A review that does not cover the pushed content. A checked fix counts as covered: it changes
     only what its finding or failing check needs, and the checks that cover it passed after it.
   - User-visible behavior that QA did not test, or that QA found failing. Untested behavior gets a
     `[ ]` verification line in the body.
   - An open finding. A finding closes when its fix is checked as above or reviewed again, or when
     the user dismisses it as not a defect. Record the dismissal reason in the session report.
     Deferred, Blocked, or unfixed findings stay open.

   Areas a worker read shallowly are session-report notes, not gaps. Accept checked fixes without
   asking, and list them in the session report. If other post-review commits make review coverage
   the only gap, such as a fix that changes behavior beyond its finding, ask once: run a new fast
   review or continue with the gap. Run a new review when the user asks for one. After a new review,
   suggest a status again.

7. Write the title and body. Save the title as `$prdir/title.md` and the body as `$prdir/body.md`.
   Publish with the title from `title.md`.
   - Release notes: when step 2 wrote release notes, such as a `.changeset` file, also save their
     text as `$prdir/release-notes.md`. `draft_review` reads only files under `.tau/`, so it cannot
     review the committed file. When a review edits the copy, apply the edit to the committed
     release notes file in a commit before you publish.
   - Template: for a new PR or a body not following the template, find `pull_request_template.md`
     case-insensitively in the root, `.github/`, `docs/`, or a `PULL_REQUEST_TEMPLATE/` directory.
     When several fit, use the repository's clear default and name it in the preview; ask when they
     imply different requirements. Without one, use the [fallback template](fallback-template.md).
     Show any restructuring it needs in the preview.
   - Title: match the repository's convention.
   - Length: aim for 100 to 150 words of text you write this session, and never pass 200. Kept text
     and the template's own headings and checklist items do not count. Do not repeat the diff or
     commit messages anywhere in the body, such as "Every production caller passes `context.ui`".
   - Lead: one bold sentence on what the PR changes. Then one or two sentences on the cause or
     constraint the diff cannot show. Give each unrelated change one line.
   - Decisions: optional. List only consequential choices, each with the option you rejected and
     why. Put code-local reasons in a code comment allowed by the coding rules, or in a commit
     message. Leave draft upstream issues and similar attachments out of the body.
   - Verification: outcomes and gaps only, in the template's verification section, such as
     Validation, Testing, or How to test. Keep that section even if optional for low-risk changes.
     If the template has no such section, put Verification after the summary. Give one line to each
     check or scenario that ran, naming the behavior it exercised, and its setup only when a
     reviewer must repeat it. Give one line to the review result. Add a `[ ]` line for each untested
     behavior, failed or missing required check, open finding, and not-run audit item that step 6
     did not close. Add a `[ ]` line for fixes that no review covered only when that changes
     confidence. Drop test counts. List deferred audit items under the template's deferred
     verification section, such as `##### Deferred verification`.
   - Issues: link Linear tickets as the [tracker skill](../tracker/SKILL.md) says. For other issues,
     use `Fixes <issue>` only for issues this PR completes; use `Related to <issue>` for others.
   - Repository template: apply the same rules inside it. Map the lead, context, decisions, and
     verification to the template's matching sections. Leave out an optional section with nothing to
     say. Keep a required heading and write the shortest true content under it, such as "None". A
     Changes section holds only decisions and unrelated changes, never a list of the diff. Keep the
     template's checklist items. Never state one fact in two sections.
   - Keep SHAs, worker names, local paths, and everything step 8 lists for the session report out of
     the body, except the verification outcomes and gaps above.
   - Self-review comments: optional, and most PRs have none. Draft an inline comment only for a hunk
     that looks wrong but is deliberate, or where a reviewer would likely suggest an alternative
     that was rejected for a reason the diff cannot show. Never draft a routine explanation, a
     narration of the diff, or a fix receipt. There is no fixed limit, but a need for many comments
     means the reasons belong in code comments or the PR is too large.

8. Preview and ask for approval. Show title, full body, base repository and branch, head, draft
   status, commits to push, and push command. The review requests of step 11 need no preview.
   - After a rebase in step 1 of a branch with a remote tip, say that the push is a force-push and
     show it with `--force-with-lease=refs/heads/<branch>:<old-tip>`.
   - For an existing PR whose base changes, show the current base and the new one.
   - In a stack, list each branch to push with its local SHA and explain that each is force-pushed
     with a lease. Show the `gh stack link` command, or why step 9 cannot link.
   - Include the session report: commits made, comment removals, review and check sources, review
     history, reviewed commits, fixes accepted without a new review and what each fixes, rebase
     notes, machine-local failures that do not block relevant coverage, reviewer notes, dismissed
     findings with their reasons, and gaps.
   - For a self-review, show the review's top-level body and each comment's text, file, line, and
     the head SHA it anchors to. A change to the body, a text, or an anchor needs a new preview,
     unless the user's answer named that exact change and you apply it as stated. The anchor's side
     is `LEFT` for a deleted line and `RIGHT` otherwise; show it with the line.
   - Ask for approval with these options in this order: Review in tuicr, Publish as draft, Publish
     as ready, Change something. Recommend Review in tuicr. Put the title and full body in the
     question-level `preview`.
   - In the publish option descriptions, mark the status step 6 suggests. For a draft suggestion,
     give the number of gaps and point to the session report, which lists them, so the user sees
     what ready leaves open. For an existing PR, say whether each option keeps or changes its
     current draft status. Keep each description within the tool's length limit.
   - Publishing as ready with open gaps keeps their `[ ]` verification lines in the body.
   - Closing the dialog publishes nothing. Report that and stop.
   - Review in tuicr: follow the review loop in step 5 of the [tracker skill](../tracker/SKILL.md)
     with `title.md`, `body.md`, and `release-notes.md` when it exists. Apply the changes, preview
     again, and ask again. A review is never approval, and a reviewed change needs a new preview.

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
    repository, PR number, title, base, and draft status. Report each difference and the PR URL.
    Stop if the call fails or shows a difference.

11. Request the review bots from the user's config. A request is a reply to a GitHub bot that
    follows [Hard rules](../tracker/SKILL.md#hard-rules). Run this on a new PR and on an update.
    Call the `pr` tool's `reviewBots` action with the approved repository and PR number. For each
    bot with status `request`, save its `comment` exactly, with no trailing newline, as
    `$prdir/bots/<index>.md` with the `write` tool, and run
    `gh pr comment <number> --repo <repo> --body-file $prdir/bots/<index>.md`. Never put the comment
    in the command line, where the shell would change it. Skip `reviewed` and `requested`. When the
    action returns no bots, the config has no entry for the repository: request no bot and say so in
    the report. Read the action again before a retry, since a failed post may still have landed.
    Posting a request does not prove a review started.

12. Post the approved self-review as one GitHub review, if the preview showed one.
    - Read the pushed head with
      `gh pr view <number> --repo <repo> --json headRefOid --jq .headRefOid`. Stop if it differs
      from the previewed anchor SHA, and preview again. Check that each file and line exists on its
      side of the PR diff at that head.
    - Save the previewed review as `$prdir/review.json`, with the previewed body and comments:
      `{"commit_id": "<head SHA>", "event": "COMMENT", "body": "<previewed body>", "comments": [{"path": "<file>", "line": <line>, "side": "<side>", "body": "<text>"}]}`.
      `event` must be set, or GitHub leaves the review pending. `body` is required for `COMMENT`.
    - Post with
      `gh api --hostname <host> --method POST repos/<owner>/<name>/pulls/<number>/reviews --input $prdir/review.json`.
      If it fails, read the PR's reviews before any retry, since a failed post may still have
      landed.
    - Report the posted review, then stop.
