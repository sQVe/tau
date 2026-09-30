---
name: pr-comments
description:
  Run one review round on a GitHub pull request. Fetches unresolved review threads and comments,
  verifies each as a claim, then fixes, commits, pushes, replies, and resolves on the user's own PR,
  or checks the author's fixes on someone else's. Use it for "fetch PR comments", "are the review
  comments valid", "fix and resolve the threads", or "check if they fixed my comments".
---

# PR comments

## When to use

Use this skill for one review round on a GitHub pull request. It needs `gh` authenticated for the
PR's host.

## Goal

Every review comment that still needs something from us is fixed, declined with a reason, answered,
or reported as open. Replies tell the reviewer only what they cannot see for themselves.

## Hard rules

- Decide the mode from GitHub, never from the local checkout. The user often clones other people's
  PRs to review them.
  - Author mode: the PR author is the viewer, or the user asks you to fix this PR. The request
    authorizes fixes, commits, one push, replies, and resolving threads.
  - Reviewer mode: every other PR. Never commit or push. Resolve only threads the viewer started.
- A request to draft only, investigate only, or approve first limits this skill. Follow it.
- Show drafts to the user before posting to a person, and ask with `ask_user_question`. Post to a
  bot directly. The author is a bot only when GitHub says so: `__typename` `Bot` in GraphQL, or
  `user.type` `Bot` in REST. A thread with any comment from a person is a person's thread. In author
  mode on a PR the viewer did not write, show every draft.
- Commit with the [commit skill](../commit/SKILL.md). Never rebase or force-push.
- Never request new bot reviews.

## Procedure

1. Resolve the target.
   - Take the PR from the request, or from `gh pr view --json number` on the current branch. Ask
     when neither gives one. Run `gh auth status --active --hostname <host>` and stop if it fails.
   - Use `<host>/<owner>/<name>` as `<repo>`, and pass `--hostname <host>` to every `gh api` call.
   - Read the viewer with `gh api user --hostname <host> --jq .login`, and the PR with
     `gh pr view <pr> --repo <repo> --json number,url,state,author,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify`.
     Stop unless the state is `OPEN`. Choose the mode.

2. Pin the code you verify against.
   - Author mode: stop and say what differs unless the worktree is on the PR's head branch, the tree
     is clean, and after a fetch `HEAD` equals `headRefOid`. On a fork, stop when
     `maintainerCanModify` is false and the viewer does not own the fork.
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

4. Verify each remaining finding with the
   [triage findings](../../src/extensions/snippets/snippets/triage-findings.md) rules. Split a
   comment with several findings and verify each one. Verify an outdated thread against the pinned
   code; outdated does not mean fixed. A question from a reviewer needs an answer, not a verdict. In
   reviewer mode, handle the threads like this, then go to step 8:
   - For each thread the viewer started, check whether the author fixed it. Mark it to resolve when
     fixed. When the author declined with a reason, treat the reason as a claim: mark it to resolve
     when it holds, draft a follow-up when it does not. Draft a follow-up for anything else left.
   - Report threads started by other reviewers. Do not reply to or resolve them.

5. Fix the supported findings at the root cause. Make small fixes yourself. Send a fix that needs
   new tests or spans modules to a `worker`, then a `reviewer`. For a finding that is valid but
   outside the PR's scope, ask the user. If they approve, file an issue in the tracker the
   repository uses, such as Linear when branches or commits name Linear IDs, and cite it in the
   reply. Commit through the commit skill, one commit per thread where practical, so each reply
   names its commit.

6. When the round committed fixes, run the repository's required checks once. Fix failures the round
   caused and run the affected checks again. For any other failure, read
   `gh pr checks <pr> --repo <repo>` for the head from before the round. Stop before you push when
   it failed there too, or when there is no result.

7. Push once with `git push <remote> HEAD:refs/heads/<headRefName>`, where `<remote>` is the PR's
   head repository. If the push is rejected, stop and report. A round that only declines or answers
   does not push.

8. Draft the replies with the rules below. Show drafts for people in one `ask_user_question` batch,
   where the user chooses post, edit, or skip for each. A skipped thread stays open.

9. Post and resolve.
   - Read `headRefOid` and every source from step 3 again. Stop and report if the head moved other
     than by your push, or a person commented since step 3. Bot replies and threads marked outdated
     by your push do not stop the round.
   - Reply to a thread with
     `gh api --hostname <host> -X POST repos/<owner>/<name>/pulls/<pr>/comments/<databaseId>/replies -f body=<text>`,
     using the `databaseId` of its first comment.
   - Resolve a fixed, declined, or tracked thread, or one marked in reviewer mode, with
     `gh api graphql --hostname <host> -f query='mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }' -F id=<thread id>`.
     Leave a thread open when it holds an answered question or the reviewer owns the next step. When
     `viewerCanResolve` is false, reply and report that you could not resolve it.
   - Answer findings from review summaries and conversation comments in one PR comment with
     `gh pr comment <pr> --repo <repo> --body <text>`. Link each source comment.
   - If a post fails, stop and report which replies were posted.

10. Report. In author mode, use the headings Fixed, Not worth changing, Incorrect, and Blocked from
    the triage rules, then Answered or left open for questions and threads that wait on the
    reviewer. In reviewer mode, use Resolved, Follow-up drafted, and Open for other reviewers. Give
    each bullet the thread link and what you did: replied, resolved, or left open. List what you
    judged as needing nothing, so the user can overrule it. End with the checks you ran.

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
