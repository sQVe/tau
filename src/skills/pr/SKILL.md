---
name: pr
description:
  Create or update the GitHub pull request for the current branch. Prepares commits and release
  notes, checks comments, reuses or runs review and checks, and previews publication for approval.
  Use it for "open a PR", "create a pull request", "update the PR", or "mark the PR ready".
metadata:
  required-for: creating, updating, or marking ready a pull request
---

# Pull request

## When to use

Use this skill for the branch in this session's worktree.

## Goal

Publish a PR matching the approved preview, pushed commits, and chosen draft status. The user may
choose draft or override step 6's draft suggestion to ready. Neither choice completes required work.

## Hard rules

- Push, create or edit a PR, or change its draft status only after the user approves the preview. A
  change after approval needs a new preview, unless the approved option or the user's answer already
  named that exact change and you apply it as stated, or the user made it in tuicr during that
  approval.
- Apply the [decision evidence publication gate](../shared/decision-evidence.md#publication-gate)
  independently of readiness and slice audits, including updates, ready transitions, retries, and
  continue paths. Neither a draft choice nor a ready override bypasses it.
- Ask every question with `ask_user_question`, including review approval and preview approval. Never
  ask in prose.
- Never force-push unless the user asks or approves its preview, including a stack's force-push.
  Outside a stack, rebase only as step 1 allows or when the user asks.
- Commit with the [commit skill](../commit/SKILL.md). Never stash, discard, or commit unrelated
  changes. Ask when ownership is unclear or unrelated changes could affect review or checks.
- Treat the PR or branch as the user's own only when `pr` `evidence` returns `ownership.status` as
  `own`.
- On the user's own PR or branch, fix supported, in-scope review findings and the in-scope causes of
  failing checks without asking, unless the user asked for a read-only review or no changes. On
  anyone else's, fix only with the user's approval. Never weaken a check or add a retry to hide a
  failure.
- On updates, keep title and body text you did not write this session. Change only wrong or missing
  facts, and preview each change.
- After a partial failure, stop and report what completed. Before retrying, read the remote branch
  and PR, including bot status or reviews for a failed post: it may have landed.
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
     over an open PR's base, so the target and merge base follow the stack. Select the newest
     `.tau/workers/review-*` for this branch from its saved input or session evidence. Read its
     `report.md` target kind and identity. For a fix, follow its recorded predecessor directory back
     to the full root, checking `capture.json` `target.review` at each link. Take each earlier
     identity from its successor's recorded predecessor identity (`target.predecessor.identity`),
     not from a fresh hash of that earlier capture. For the newest identity only, use
     `git hash-object <directory>/capture.json` if its report has none. Pass `chain` as
     `[{directory, identity}]`, root first, and the root directory as `review` together. Report
     unclear ownership, missing links, or unavailable identities as evidence gaps; never invent a
     link or identity. When these prevent selecting a chain, pass the available root as `review` and
     assess the saved evidence manually in step 4.
   - Find ticket IDs in the user's links, `branch`, `subjects`, and `target.pr.body`. Read each
     distinct ticket with its service's CLI, using returned issue IDs rather than branch aliases.
     Keep its title and `## Acceptance` as intent. For slice children, follow the
     [start-slice skill](../start-slice/SKILL.md) and keep their acceptance too.
   - Read the slice's `# Slice audit: <slice>` comment with
     `linear issue comment list <slice> --json --no-pager`. Print its audited commit and rows.
   - After the script, when a slice ticket has no audit comment, or its audited commit differs from
     `HEAD`, ask with `ask_user_question`: run a new audit with the
     [finish-slice skill](../finish-slice/SKILL.md), recommended, or continue with the missing or
     old audit. Then each slice or agent ticket acceptance item no step 5 check covers is not run.
   - Print target and ticket intent, coverage and reuse evidence, review freshness, skip,
     suppression, and deleted test markers, and matching check logs and `fullCheck` with paths and
     bounded excerpts. Keep one gap list for tool gaps, failed or skipped reads, missing intent, and
     omitted evidence. Read omitted evidence through its returned path when needed.
   - The script gathers evidence only. It never calls `prepare` or `verify`, and writes nothing
     itself. Target questions, rebases, review runs, previews, and approvals stay outside it.
   - If `target` is null because no head remote or several were found, ask which remote to use and
     rerun the script. On any other target error or a failed evidence call, tell the user and stop.
   - Use `target.repository` as `--repo <repo>` for repository-scoped `gh` commands, `target.head`
     for the push remote and branch, and `target.mergeBase` as the merge base.
   - Use the open PR in `target.pr`. If it is null and `target.closedPrs` lists merged or closed
     PRs, ask before continuing. When its `baseRefName` differs from `target.base.branch`, step 9
     changes the PR's base.
   - Outside a stack, when conflicts or checks need a base change, rebase locally with the
     [update-branch skill](../update-branch/SKILL.md) and tell the user, without asking to approve
     the rebase even if already pushed. Keep its dirty-tree question and product-conflict stop and
     ask. Note the remote tip as `<old-tip>` for step 8's force-push preview. Rerun the evidence
     script after rebasing to pin the new merge base.

2. Commit the task's changes and required release notes, such as a `.changeset` file. List unrelated
   changes in the session report.

3. Run the [prune-comments skill](../prune-comments/SKILL.md) on the commits added after the review.
   - Run it on the diff since the newest link of step 1's chain: a `fix` target with that link's
     directory as `review` and empty `findingPaths`. The diff starts at the content the review read,
     so work that was uncommitted during the review stays out.
   - With no saved review for this branch, run it on `<merge base>..HEAD`.
   - It commits its own removals. Do not commit them here.
   - Later commits that add comments before the preview: run it again on those commits only.
   - Report each removal in the session report, not the PR body.
   - Note a failed run, including a missing skill or worker tools, in the session report. It does
     not change the draft status in step 6. Go on.

4. Review `<merge base>..HEAD`, with both ends pinned. Rerun step 1's evidence script after commits
   or saved evidence changes. Coverage compares committed HEAD, not the working tree.
   - For `coverage.status: match`, accept content coverage without a new full review, even after a
     HEAD move or stale freshness when reviewed content was committed unchanged. Keep freshness and
     single-review reuse separate from coverage; content identity is not a clean verdict.
   - Read each link's `report.md` and worker reports (`reviewer.md`, or `finder.md` and
     `checker.md`). Check completion, verdicts, findings, dispositions, fix scope, and relevant
     caller or rule changes outside captures. Unstated completion is unknown.
   - An unfinished reviewer, unreadable required report, fix beyond its findings, or relevant
     outside change leaves a named required action, even with `match`. State the missing evidence or
     scope and its completion condition for step 6; shallow reading alone stays a note.
   - For `mismatch` or `unknown`, use `reasons` and `links` to restore evidence or review uncovered
     scope. Name genuinely missing evidence as a required action, not a generic mismatch. Recheck
     after repairs; neither result is a pass.
   - For `unsupported` or evidence that cannot form a chain, assess manually without asking.
   - Manually read the full review, its fix reviews, and the later diff, with the checks above.
   - Record the inspected paths and judgment in the session report, never as a match or fresh.
   - Missing evidence from a manual assessment stays a required action.
   - If coverage stays unestablished, ask: rereview uncovered scope fast, or keep the action open.

   Without saved review, or when the user chooses rereview, follow the
   [code-review skill](../code-review/SKILL.md) in fast mode on uncovered scope (the pinned range
   when none is covered). Missing skill or worker tools leave a required action for review coverage;
   do not review in their place.

   For a slice whose audit step 1 found current, reuse its decision-evidence row when the row is
   met, instead of assessing again. Recheck commits from steps 2 and 3 under the
   [shared recheck rules](../shared/decision-evidence.md#reuse-and-recheck); a commit that changes
   what the conclusion rests on ends reuse. When reuse does not apply, follow the
   [decision-evidence assessment](../shared/decision-evidence.md#assess-the-change) for the selected
   reports, with or without tickets. Keep the reused evidence or assessment and sources in the
   session report. Resolve contradictions before publication. For remaining gaps, stop or obtain the
   shared guidance's explicit change-specific exception; open review actions are not an exception.

5. Run checks. Rerun the evidence script first. Reuse a required pre-merge check only when the
   script lists its log as matching and reading its result shows it passed. The full check is the
   exception below. A match does not detect every edit to an already dirty file. Otherwise run it
   once on the committed tree. Rerun affected checks after relevant changes, even if their headers
   still match.
   - In a stack, restack with the [stack skill](../stack/SKILL.md). Check this branch and changed
     branches above it. Repeat after later commits before previewing; step 9 pushes them all.
   - Save each other check's real output and exit status as `$prdir/checks/<name>.log`, preceded by
     the `pr` tool's `checkHeader` lines for the pinned merge base. Stop if that action fails.
   - For a configured full check, reuse passed `fullCheck` evidence; otherwise run `full_check`.
     Rerun the evidence script and carry any non-passed result into step 6 as a required action.
     Leave its log in place without copying it or adding headers.
   - When the change has user-visible behavior, also send it to a `qa` worker on the committed tree
     before the preview.
   - Leave the app URL, test account, and data writes to Tau, which fills them from the user's
     config. Ask the user nothing about them in advance.
   - When the QA worker asks a blocking question, pass it to the user.
   - Record what QA tested and found for step 6 and the preview.

6. Suggest a draft status. Any open required action makes draft the suggested status; otherwise
   suggest ready. A required action needs a basis and a completion condition. Name both in the
   preview. A basis is one of:
   - Agreed acceptance: an acceptance item of the ticket that the change does not meet, or that no
     check has shown.
   - An applicable project check or support contract that failed or did not run. Only checks that
     can run solely after deployment are deferred instead.
   - Review coverage that is genuinely missing for the pushed content. A checked fix counts as
     covered: it changes only what its finding or failing check needs, and the checks that cover it
     passed after it.
   - A concrete risk that this change introduced, exposed, or worsened. An open finding is one, and
     so is user-visible behavior that QA found failing.
   - An audit item with the verdict not met or not run, and each uncovered item of a missing or old
     audit. It closes when a check that step 5 ran passes for it. A decision-evidence row also
     closes when step 4's assessment supports a conclusion for HEAD. A deferred item is not a
     required action.

   A coverage number, missing assertion, untested platform, or record-format mismatch alone is not a
   required action. Missing evidence for promised behavior can still require a test or review.
   Unrelated pre-existing failures need reproduction on the base or a cited log showing an outside
   cause; otherwise they remain unexplained required actions. An issue is exposed only if newly
   reachable or worsened, not another route to existing behavior. Report unrelated issues as plain
   limitations when they affect use, otherwise in the session report.

   Accepted follow-ups are not required actions only if they waive no promised behavior or mandatory
   check. Findings close through a checked fix, rereview, or user dismissal as not a defect. Record
   dismissal reasons. Deferred, Blocked, and unfixed findings stay open unless accepted as such a
   follow-up. Coverage matches do not close findings or replace this judgment.

   Keep per-link report paths, verdicts, fix-scope assessments, shallow-reading notes, and accepted
   checked fixes in the session report. Accept checked fixes without asking. If other post-review
   commits leave only review coverage open, ask once: run a new fast review or continue with that
   action open. Run a review when the user asks, then suggest a status again.

7. Write the title and body. Save the title as `$prdir/title.md` and the body as `$prdir/body.md`.
   Publish with the title from `title.md`.
   - Release notes: save step 2's release notes as `$prdir/release-notes.md`. Apply review edits of
     that copy to the committed release notes file in a commit before publishing.
   - Template: for a new PR or a body not following the template, find `pull_request_template.md`
     case-insensitively in the root, `.github/`, `docs/`, or a `PULL_REQUEST_TEMPLATE/` directory.
     When several fit, use the repository's clear default and name it in the preview; ask when they
     imply different requirements. Without one, use the [fallback template](fallback-template.md).
     Show any restructuring it needs in the preview.
   - Title: match the repository's convention.
   - Reader: assume product knowledge, not the ticket, plan, or code. Name parts by what they do.
   - Length: aim for 100 to 150 words written this session, never over 200. Exclude kept text,
     template headings and checklist items, and verification lines. Cut repetition before adding
     length. Never repeat the diff or commit messages in the body.
   - Lead: one bold sentence led by PR type. Features name the user benefit; fixes give symptom then
     cause; refactors say "no behavior change" and why; tooling names the new developer action.
   - Context: one or two sentences on the cause or constraint the diff cannot show.
   - Scope limits: state one only where a reader would assume more.
   - Example: add a concrete one only when it clarifies the purpose. Do not force a user story.
   - Unrelated changes: give each one line.
   - Parts: at most four optional bullets, each naming a behavior and its effect in plain words.
     Never list files, functions, hooks, or types.
   - Code names: use one only where a reviewer must search for it, such as a flag, an environment
     variable, or a route. Explain it at first use. Never put one in the lead.
   - Unfinished work: when the PR adds code that nothing uses yet, say what stays disconnected. Link
     any follow-up ticket in Verification. Never promise a delivery time.
   - Decisions: list consequential choices with rejected options and reasons. Put code-local reasons
     in allowed code comments or commit messages. Leave draft upstream issues and attachments out.
   - Decision evidence: put the conclusion, supporting evidence, and approved gap exceptions with
     risks in the matching section or Verification. Never claim an exception is compliance. Keep
     local references in the session report; a supported no-change conclusion needs no document.
   - Verification: keep the template's verification section even if optional, or add Verification
     after the summary. Give each check or scenario one line naming behavior and outcome, and the
     review result one line. Name test machinery or setup only to judge coverage or repeat a check.
     Add a `[ ]` line only for each step 6 required action, with its completion condition. Drop test
     counts. Put decision-relevant limitations as plain lines and accepted follow-ups as links in
     their template slots. Put deferred audit items in its deferred verification section.
     Bookkeeping, record matching, and unrelated issues belong in the session report.
   - Issues: link Linear tickets as the [tracker skill](../tracker/SKILL.md) says. For other issues,
     use `Fixes <issue>` only for issues this PR completes; use `Related to <issue>` for others. A
     slice with an open acceptance item gets `Related to`, since `Fixes` closes it on merge.
   - Repository template: map these rules to matching sections. Omit empty optional sections; keep
     required headings with the shortest true content, such as "None". Changes holds only parts,
     decisions, and unrelated changes. Keep the template's checklist intact; the required-action
     rule covers only added verification lines. Never state one fact in two sections.
   - Keep SHAs, worker names, local paths, and session-report-only details out of the body.
   - Self-review comments: optional, usually none. Comment only on a deliberate hunk that looks
     wrong or a likely alternative rejected for a reason the diff cannot show. Never narrate the
     diff, explain routine code, or post fix receipts. Many comments suggest code comments or a
     smaller PR.
   - Self-test: can a reviewer without the ticket explain the purpose, changes, limits, and
     evidence? Remove unfamiliar internal terms. Weaken or cut claims without test or diff backing.

8. Preview and ask for approval. Show title, full body, base repository and branch, head, draft
   status, commits to push, and push command. The review requests of step 11 need no preview.
   - After a rebase in step 1 of a branch with a remote tip, say that the push is a force-push and
     show it with `--force-with-lease=refs/heads/<branch>:<old-tip>`.
   - For an existing PR whose base changes, show the current base and the new one.
   - In a stack, list each branch to push with its local SHA and explain that each is force-pushed
     with a lease. Show the `gh stack link` command, or why step 9 cannot link.
   - Include the session report from earlier steps: commits, comment removals, review and check
     sources, reviewed commits, coverage and manual judgments, fixes and their purposes, rebase
     notes, non-blocking machine-local failures, reviewer notes, and the combined gap list.
   - For a self-review, show the top-level body and each comment's text, file, line, anchor head
     SHA, and side (`LEFT` for deleted lines, `RIGHT` otherwise). The Hard rules approval rule
     covers changes to the body, text, or anchor.
   - Follow the approval rule in step 5 of the [tracker skill](../tracker/SKILL.md) over `title.md`,
     `body.md`, and `release-notes.md` when it exists, passed to `draft_review` in that order. When
     one review covers the drafts of several PRs in a stack, pass each PR's files bottom to top. Ask
     with these options in this order: Publish as draft, Publish as ready, Change something. Publish
     as draft and Publish as ready are Accept. Change something is Request changes. Put the title
     and full body in the question-level `preview`.
   - Before the question, apply the
     [publication gate](../shared/decision-evidence.md#publication-gate). Show the decision
     conclusion and any explicitly approved gap exception in the preview, matching the body. Obtain
     separate explicit gap approval before offering publication with that gap.
   - Before the question, show each required action's basis, next action, and completion condition
     in the session report. Put it and other preview items in visible text or the question's
     `preview`.
   - Keep `problem` to one or two branch-state sentences within the tool's limit.
   - Mark the suggested status in option descriptions. For draft, give the open-action count and
     point to the report so ready's remaining work is clear. For existing PRs, say whether each
     option keeps or changes draft status. Keep descriptions within the tool's limit.
   - Publishing as ready keeps open required actions as `[ ]` lines in the body. Approval does not
     complete them.
   - Closing the dialog publishes nothing. Report that and stop.
   - For tuicr edits, comments, conflicts, and Change something, use that approval lifecycle: revise
     and ask again when it requires a new preview. A review is not approval.

9. Publish.
   - Follow the [decision-evidence recheck](../shared/decision-evidence.md#reuse-and-recheck) after
     user edits, including tuicr edits and release-note commits. Read the final files and supporting
     sources. Changed conclusions, gaps, or removed disclosures need refreshed evidence and a new
     preview, with new exception approval when needed. Harmless edits retain the approval shortcuts.
   - Compare HEAD, local status, commits to push, and each stacked branch's SHA with the preview;
     read the PR again. If anything changed, stop, refresh evidence, and preview without losing
     edits. A commit applying only approved release-note edits is covered by the Hard rules
     exception; rerun affected checks before publishing.
   - Push with `git push <remote> HEAD:refs/heads/<branch>`, adding `-u` for a new branch. After a
     step 1 rebase, push as the [update-branch skill](../update-branch/SKILL.md) says; in a stack,
     use the [stack skill](../stack/SKILL.md). Stop and report a rejected push.
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

10. Check the published PR against the approval with the `pr` tool's `verify` action. Report each
    difference and the PR URL. Stop if the call fails or shows a difference.

11. Request the review bots from the user's config. A request is a reply to a GitHub bot that
    follows [Hard rules](../tracker/SKILL.md#hard-rules). Run this on a new PR and on an update.
    Call the `pr` tool's `reviewBots` action. For each `request`, save its `comment` exactly, with
    no trailing newline, as `$prdir/bots/<index>.md` with `write`, and run
    `gh pr comment <number> --repo <repo> --body-file $prdir/bots/<index>.md`. Never put the comment
    in the command line, where the shell would change it. Report when no bots are configured.
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
    - Report the posted review, then stop.
