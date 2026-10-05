---
name: pr-feedback
description:
  Run one feedback round on a GitHub pull request, covering review comments, failing CI checks, and
  merge conflicts. On the user's own PR it fixes, rebases, pushes, replies, and resolves. On someone
  else's it checks the author's fixes. Use it for "address the PR feedback", "fix CI on my PR",
  "fetch PR comments", "are the review comments valid", "fix and resolve the threads", or "check if
  they fixed my comments". For a plain rebase, use update-branch.
metadata:
  required-for:
    replying to or resolving pull request review comments, including as a step in a larger task
---

# PR feedback

## When to use

Use this skill for one feedback round on a GitHub pull request. It needs `gh` authenticated for the
PR's host.

## Goal

Every review comment that still needs something from us is fixed, declined with a reason, answered,
or reported as open. Every failing check is fixed, or reported with its cause when known. In author
mode, the branch no longer conflicts with its base. Replies tell the reviewer only what they cannot
see for themselves.

## Hard rules

- Decide the mode from GitHub, never from the local checkout. The user often clones other people's
  PRs to review them.
  - Author mode: the PR author is the viewer, or the user asks you to fix this PR. The request
    authorizes fixes, commits, one push, replies, resolving threads, and a rebase when the PR
    conflicts. In a stack, the one push is one stack push, and the request also authorizes
    restacking the branches above the PR.
  - Reviewer mode: every other PR. Never commit, rebase, or push. Report failing checks and
    conflicts without fixing them. Resolve only threads the viewer started.
- A request to draft only, investigate only, or approve first limits this skill. Follow it.
- Show drafts to the user before you post to a person, and ask with `ask_user_question`. Post to a
  bot directly. The `pr_feedback` tool decides who is a bot and which writes go to a person. In
  author mode on a PR the viewer did not write, show every draft.
- Commit with the [commit skill](../commit/SKILL.md). Rebase and force-push only as steps 2 and 7
  say. Run every stack command through the [stack skill](../stack/SKILL.md).
- Never rerun a check, or add retries, skips, or longer timeouts, to make a failure pass.
- Never request new bot reviews.

## Procedure

1. Resolve the target.
   - Take the PR from the request. Otherwise, when the stack skill finds the current branch in a
     stack, read each open PR's `mergeable`, checks, threads, review summaries, and conversation
     comments with the commands below and the `pr_feedback` tool as in step 3. List the PRs with a
     conflict, failing checks, or comments that step 3 keeps, and ask which to handle with
     `ask_user_question`. Otherwise use `gh pr view --json number` on the current branch. Ask when
     nothing gives a PR.
   - Run `gh auth status --active --hostname <host>` and stop if it fails. Use
     `<host>/<owner>/<name>` as `<repo>`, and pass `--hostname <host>` to every `gh api` call.
   - Read the viewer with `gh api user --hostname <host> --jq .login`, and the PR with
     `gh pr view <pr> --repo <repo> --json number,url,state,author,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify,mergeable,mergeStateStatus`.
     Stop unless the state is `OPEN`. Choose the mode.
   - `mergeable` reads `UNKNOWN` while GitHub computes it. Read it again up to three times. If it
     stays `UNKNOWN`, report it and skip the rebase.
   - Read the checks with `gh pr checks <pr> --repo <repo> --json name,bucket,link,workflow`. It
     exits non-zero while checks fail or are pending, so read the JSON anyway. Do not wait for
     pending checks.

2. Pin the code you verify against.
   - Author mode: when the PR is in the current branch's stack and the tree is clean, switch to it
     with the stack skill. Then stop and say what differs unless the worktree is on the PR's head
     branch, the tree is clean, and after a fetch `HEAD` equals `headRefOid`. On a fork, stop when
     `maintainerCanModify` is false and the viewer does not own the fork.
   - Author mode, when `mergeable` is `CONFLICTING`: note `headRefOid` as the old head. Then run the
     [update-branch skill](../update-branch/SKILL.md) onto `baseRefName`, without its checks and
     push steps. Rebase before you collect or fix anything, so the SHAs in replies stay valid.
   - Reviewer mode: use the checkout only when it is clean and `HEAD` equals `headRefOid`. Otherwise
     run `git fetch <remote> refs/pull/<pr>/head` against the base repository's remote, and read
     files with `git show <headRefOid>:<path>`.

3. Collect the comments.
   - Call the `pr_feedback` tool with `read` for the threads, review summaries, and conversation
     comments. Keep its result for steps 8 and 9. If it fails, stop and report. If its `headRefOid`
     differs from the head this round expects, stop and report that the PR moved. The expected head
     is step 1's `headRefOid`, or the head of step 7's push when step 9 reads again.
   - Skip bot walkthroughs, link comments, and summaries that hold no findings.
   - Read what we already posted, and judge whether each thread or comment still needs something
     from us. It does not when our reply settled it and the reviewer has not pushed back. It does
     again when the reviewer answered, or when our reply promised a fix that is not in the code.
   - Author mode, failing checks: each check from step 1 with `bucket` `fail` or `cancel` is a
     finding.
     - Read its log. For GitHub Actions, run
       `gh run view <run id> --repo <repo> --job <job id> --log-failed` with the IDs from `link`.
       For other providers, follow `link`.
     - Compare with the trunk, which is `baseRefName`, or the stack's `trunk` when the PR is in a
       stack:
       `gh run list --repo <repo> --branch <trunk> --workflow <workflow> --limit 5 --json conclusion,headSha,url`.
       In a stack, also read the checks of the PRs below.
     - A failure belongs to the PR only when its cause is in the PR's own commits and still in the
       pinned code. Fetch the base repository's remote and list those commits with
       `git log --oneline HEAD --not <base remote>/<baseRefName>`. In a stack, add the branch's
       `base` SHA from `gh stack view --json` after `--not`. The local parent branch can be stale
       and the remote one can be rewritten, so either alone can let a lower PR's commits in.
     - Report the rest: failing on the trunk, caused by a PR below, a cause outside the PR such as a
       network timeout, gone after the rebase, or blocked when you cannot read the log.

4. Verify each remaining finding with the [triage findings](../triage-findings/SKILL.md) rules.
   Split a comment with several findings and verify each one. Verify an outdated thread against the
   pinned code, because outdated does not mean fixed. A question from a reviewer needs an answer,
   not a verdict. Reproduce a failing check locally when you can. In reviewer mode, handle the
   threads like this, then go to step 8:
   - For each thread the viewer started, check whether the author fixed it. Mark it to resolve when
     fixed. When the author declined with a reason, treat the reason as a claim: mark the thread to
     resolve when the reason holds, and draft a follow-up when it does not. Draft a follow-up for
     anything else left.
   - Report threads started by other reviewers. Do not reply to or resolve them.

5. Author mode: fix the supported findings at the root cause.
   - Make small fixes yourself. Send a fix that needs new tests or spans modules to a `worker`, then
     a `reviewer`.
   - For a finding that is valid but outside the PR's scope, ask the user. If they approve, file an
     issue in the tracker the repository uses, and cite it in the reply. A repository uses Linear
     when its branches or commits name Linear IDs; file those with the
     [tracker skill](../tracker/SKILL.md).
   - Commit through the commit skill, one commit per thread where practical, so each reply names its
     commit. Failing checks need no reply on the PR.

6. Author mode: when the round rebased or committed fixes, run the repository's required checks
   once.
   - In a stack, first restack the branches above the PR with the stack skill. Then run the checks
     on the PR's branch and on each branch above that the restack changed, since step 7 pushes them
     all. If you cannot check a branch, report it and stop before you push.
   - A failure is the round's, the rebase included, unless the matching check also failed in step 1
     or fails on the trunk. Fix the round's failures. In a stack, restack again after each fix
     commit. Then run the affected checks again.
   - Push past any other failure only when you report it. Otherwise stop before you push.

7. Author mode: push once to the PR's head repository `<remote>`. A round without a rebase or a new
   commit does not push.
   - In a stack, push the stack, restacked in step 6, with the stack skill.
   - Otherwise, after a rebase, push with
     `git push <remote> HEAD:refs/heads/<headRefName> --force-with-lease=refs/heads/<headRefName>:<old head>`.
   - Otherwise push with `git push <remote> HEAD:refs/heads/<headRefName>`.
   - If the push or the lease is rejected, stop and report.

8. Draft the replies with the rules in Replies below. In author mode, answer findings from review
   summaries and conversation comments in one PR comment that links each source comment. Show all
   drafts for people, or every draft in author mode on a PR the viewer did not write, in one
   `ask_user_question` question, with options to post all or skip all. The user types which drafts
   to edit or skip. A skipped thread stays open. Write the approved drafts and the resolves from
   step 9 to `replies.json` in the directory that step 3's `read` returned.

9. Post and resolve with the `pr_feedback` tool's `post`. Pass the PR's head after step 7's push as
   `head`, or `headRefOid` from step 3 when the round did not push.
   - Resolve a thread that is fixed, declined, or tracked, or that reviewer mode marked to resolve.
     Leave a thread open when it holds an answered question or the reviewer owns the next step.
   - When `viewerCanReply` is false, report the thread instead of replying. When `viewerCanResolve`
     is false, reply and report that you could not resolve it.
   - When a person changed a comment since step 3, read again, redo steps 3, 4, and 8 for what
     changed, and post with the new result. When the head moved other than by your push, stop and
     report.
   - When the user declines, post nothing and report the drafts. If a post fails, stop and report
     which replies were posted.

10. Report.
    - Author mode: use the headings Fixed, Not worth changing, Incorrect, and Blocked from the
      triage rules, then Answered or left open for questions and threads that wait on the reviewer.
    - Reviewer mode: use the headings Resolved, Follow-up drafted, and Open for other reviewers.
    - Give each bullet the thread link and what you did: replied, resolved, or left open. List what
      you judged as needing nothing, so the user can overrule it.
    - In both modes, add a CI section with each failing or pending check, its link, and its outcome.
      Add a Conflicts section with what the rebase resolved or why it did not run. End with the
      checks you ran.

11. Author mode: when a person requested changes and the round pushed fixes, ask whether to request
    their review again with `gh pr edit <pr> --repo <repo> --add-reviewer <login>`. Default to no.

## Replies

- Say where it was done and anything the reviewer could not guess. Do not restate or explain their
  point back to them. No thanks, praise, or sign-off.
- A fixed thread usually needs one line: "Done in <sha>." Add a clause only for something the
  reviewer cannot know, such as a side effect or a deliberate difference from the suggestion. When
  an earlier commit fixed it, find that commit, for example with `git log -L`. Ask only when the
  history cannot show which commit fixed it.
- A declined thread gives the reason in one or two sentences, with the source that settles it.
- A valid finding outside the PR's scope gets `Tracked in <issue>.`
- A thread that needs nothing from us gets a short acknowledgement or no reply.
- Leave out check counts and process notes. CI shows them.
- Write a commit as its full 40-character SHA in plain text, never in backticks, so GitHub links it.
  Post only after the commit is on GitHub. Use `owner/repo@sha` only for another repository.
