---
name: pr-feedback
description:
  Run one feedback round on a GitHub pull request, covering unresolved review threads and comments,
  failing CI checks, and merge conflicts. Verifies each as a claim. On the user's own PR it rebases
  when the PR conflicts, fixes, commits, pushes, replies, and resolves. On someone else's PR it
  checks the author's fixes and reports CI and conflicts. Use it for "address the PR feedback", "fix
  CI on my PR", "fetch PR comments", "are the review comments valid", "fix and resolve the threads",
  or "check if they fixed my comments". For a plain rebase without a PR round, use update-branch.
---

# PR feedback

## When to use

Use this skill for one feedback round on a GitHub pull request. It needs `gh` authenticated for the
PR's host. To only rebase a branch or resolve conflicts, use the
[update-branch skill](../update-branch/SKILL.md) instead.

## Goal

Every review comment that still needs something from us is fixed, declined with a reason, answered,
or reported as open. Every failing check is fixed or reported with its cause. In author mode, the
branch no longer conflicts with its base. Replies tell the reviewer only what they cannot see for
themselves.

## Hard rules

- Decide the mode from GitHub, never from the local checkout. The user often clones other people's
  PRs to review them.
  - Author mode: the PR author is the viewer, or the user asks you to fix this PR. The request
    authorizes a rebase when the PR conflicts, fixes, commits, one push, replies, and resolving
    threads.
  - Reviewer mode: every other PR. Never commit, rebase, or push. Report failing checks and
    conflicts without fixing them. Resolve only threads the viewer started.
- A request to draft only, investigate only, or approve first limits this skill. Follow it.
- Show drafts to the user before posting to a person, and ask with `ask_user_question`. Post to a
  bot directly. The author is a bot only when GitHub says so: `__typename` `Bot` in GraphQL, or
  `user.type` `Bot` in REST. A thread with any comment from a person is a person's thread. In author
  mode on a PR the viewer did not write, show every draft.
- Commit with the [commit skill](../commit/SKILL.md). Rebase only to resolve conflicts in step 2,
  and force-push only with the lease in step 7.
- Never rerun a check, or add retries, skips, or longer timeouts, to make a failure pass.
- Never request new bot reviews.

## Procedure

1. Resolve the target.
   - Take the PR from the request, or from `gh pr view --json number` on the current branch. Ask
     when neither gives one. Run `gh auth status --active --hostname <host>` and stop if it fails.
   - Use `<host>/<owner>/<name>` as `<repo>`, and pass `--hostname <host>` to every `gh api` call.
   - Read the viewer with `gh api user --hostname <host> --jq .login`, and the PR with
     `gh pr view <pr> --repo <repo> --json number,url,state,author,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify,mergeable,mergeStateStatus`.
     Stop unless the state is `OPEN`. Choose the mode.
   - While GitHub computes `mergeable`, it reads `UNKNOWN`. Read it again a few seconds later, up to
     three times. If it stays `UNKNOWN`, report that and do not rebase.
   - Read the checks on the head with
     `gh pr checks <pr> --repo <repo> --json name,bucket,link,workflow`. It exits non-zero while
     checks fail or are pending; read the JSON anyway. Report pending checks; do not wait for them.

2. Pin the code you verify against.
   - Author mode: stop and say what differs unless the worktree is on the PR's head branch, the tree
     is clean, and after a fetch `HEAD` equals `headRefOid`. On a fork, stop when
     `maintainerCanModify` is false and the viewer does not own the fork.
   - Author mode, when `mergeable` is `CONFLICTING`: note `headRefOid` as the old head, then run the
     [update-branch skill](../update-branch/SKILL.md) onto `baseRefName` without its push step.
     Rebase before collecting or fixing anything, so the SHAs in replies stay valid. The rebased
     `HEAD` is the code you verify against. Ask the user when a conflict needs a product decision.
   - Reviewer mode: use the checkout only when it is clean and `HEAD` equals `headRefOid`. Otherwise
     run `git fetch <remote> refs/pull/<pr>/head` against the base repository's remote, and read
     files with `git show <headRefOid>:<path>`.

3. Collect the comments.
   - Threads:
     `gh api graphql --hostname <host> --paginate -F owner=<owner> -F name=<name> -F number=<pr> -F query=@<skill dir>/threads.graphql`.
     Keep unresolved threads. When a thread's `comments.pageInfo.hasNextPage` is true, stop and
     report that the thread is too long to read in full.
   - Review summaries:
     `gh api --hostname <host> --paginate repos/<owner>/<name>/pulls/<pr>/reviews`. Conversation
     comments: `gh api --hostname <host> --paginate repos/<owner>/<name>/issues/<pr>/comments`. Skip
     bot walkthroughs, link comments, and summaries that hold no findings.
   - Read what we already posted. Judge whether each thread or comment still needs something from
     us. It does not when our reply settled it and the reviewer has not pushed back. It does again
     when the reviewer answered, or when our reply promised a fix that is not in the code.
   - Author mode, failing checks: each check with `bucket` `fail` or `cancel` from step 1 is a
     finding. For GitHub Actions, take the run and job IDs from `link` and read
     `gh run view <run id> --repo <repo> --job <job id> --log-failed`. For other providers, follow
     `link`. Report a check as blocked when you cannot read its log.

4. Verify each remaining finding with the
   [triage findings](../../src/extensions/snippets/snippets/triage-findings.md) rules. Split a
   comment with several findings and verify each one. Verify an outdated thread against the pinned
   code; outdated does not mean fixed. A question from a reviewer needs an answer, not a verdict.
   For a failing check, name the cause from its log and reproduce it locally when you can. Check the
   same workflow on the base with
   `gh run list --repo <repo> --branch <baseRefName> --workflow <workflow> --limit 5 --json conclusion,headSha,url`.
   Report a failure that also fails on the base, or one whose log shows a cause outside the PR's
   changes, such as a network timeout. Fix only a failure the PR's changes cause. In reviewer mode,
   handle the threads like this, then go to step 8:
   - For each thread the viewer started, check whether the author fixed it. Mark it to resolve when
     fixed. When the author declined with a reason, treat the reason as a claim: mark it to resolve
     when it holds, draft a follow-up when it does not. Draft a follow-up for anything else left.
   - Report threads started by other reviewers. Do not reply to or resolve them.

5. Fix the supported findings at the root cause. Make small fixes yourself. Send a fix that needs
   new tests or spans modules to a `worker`, then a `reviewer`. For a finding that is valid but
   outside the PR's scope, ask the user. If they approve, file an issue in the tracker the
   repository uses, such as Linear when branches or commits name Linear IDs, and cite it in the
   reply. Commit through the commit skill, one commit per thread where practical, so each reply
   names its commit. Failing checks need no reply on the PR.

6. When the round rebased or committed fixes, run the repository's required checks once. Fix
   failures the round caused, the rebase included, and run the affected checks again. Compare any
   other failure with the checks from step 1. Continue when the matching check passed on the head
   from before the round, or when you report it as failing on the base or outside the PR's changes.
   Otherwise stop before you push.

7. Push once to the PR's head repository `<remote>`. After a rebase, push with
   `git push <remote> HEAD:refs/heads/<headRefName> --force-with-lease=refs/heads/<headRefName>:<old head>`.
   Otherwise push with `git push <remote> HEAD:refs/heads/<headRefName>`. If the push or the lease
   is rejected, stop and report. A round without a rebase or a new commit does not push.

8. Draft the replies with the rules below. Show all drafts for people in one `ask_user_question`
   question, with options to post all or skip all. The user types which drafts to edit or skip. A
   skipped thread stays open.

9. Post and resolve.
   - Read `headRefOid` and every source from step 3 again. Stop and report if the head moved other
     than by your push, or a person added, edited, or deleted a comment since step 3. Bot replies
     and threads marked outdated by your push do not stop the round.
   - Reply to a thread with
     `gh api --hostname <host> -X POST repos/<owner>/<name>/pulls/<pr>/comments/<databaseId>/replies -f body=<text>`,
     using the `databaseId` of its first comment. When `viewerCanReply` is false, report the thread
     instead of replying.
   - Resolve a fixed, declined, or tracked thread, or one marked in reviewer mode, with
     `gh api graphql --hostname <host> -f query='mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }' -F id=<thread id>`.
     Leave a thread open when it holds an answered question or the reviewer owns the next step. When
     `viewerCanResolve` is false, reply and report that you could not resolve it.
   - In author mode, answer findings from review summaries and conversation comments in one PR
     comment with `gh pr comment <pr> --repo <repo> --body <text>`. Link each source comment.
   - If a post fails, stop and report which replies were posted.

10. Report. In author mode, use the headings Fixed, Not worth changing, Incorrect, and Blocked from
    the triage rules, then Answered or left open for questions and threads that wait on the
    reviewer. In reviewer mode, use Resolved, Follow-up drafted, and Open for other reviewers. Give
    each bullet the thread link and what you did: replied, resolved, or left open. List what you
    judged as needing nothing, so the user can overrule it. Then add two sections in both modes:
    - CI: each failing or pending check with its link and outcome, such as fixed in a commit, also
      failing on the base, failing outside the PR's changes, pending, or blocked.
    - Conflicts: rebased onto the base with the files you resolved, conflicting but not rebased in
      reviewer mode, unknown, or none.

    End with the checks you ran.

11. In author mode, when a person requested changes and the round pushed fixes, ask whether to
    request their review again with `gh pr edit <pr> --repo <repo> --add-reviewer <login>`. Default
    to no.

## Replies

- Say where it was done and anything the reviewer could not guess. Do not restate or explain their
  point back to them. No thanks, praise, or sign-off.
- A fixed thread usually needs one line: "Done in <sha>." Add a clause only for something the
  reviewer cannot know, such as a side effect or a deliberate difference from the suggestion. When
  an earlier commit fixed it, find that commit, for example with `git log -L`, and ask when unsure.
- A declined thread gives the reason in one or two sentences, with the source that settles it.
- A valid finding outside the PR's scope gets `Tracked in <issue>.`
- A thread that needs nothing from us gets a short acknowledgement or no reply.
- Leave out check counts and process notes. CI shows them.
- Write a commit as its full 40-character SHA in plain text, never in backticks, so GitHub links it.
  Post only after the commit is on GitHub. Use `owner/repo@sha` only for another repository.
