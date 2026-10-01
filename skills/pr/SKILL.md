---
name: pr
description:
  Create or update the GitHub pull request for the current branch. Prepares commits and release
  notes, checks added comments, reuses or runs a code review and checks, then previews the title,
  body, base, and draft status for approval before it pushes or publishes. Use it for "open a PR",
  "create a pull request", "update the PR", or "mark the PR ready".
metadata:
  required-for:
    creating, updating, or marking ready a pull request, including as a step in a larger task
---

# Pull request

## When to use

Use this skill to open or update the GitHub pull request for the branch in this session's worktree.
It needs `gh` authenticated for the target host's active account.

## Goal

Publish a pull request whose description matches the pushed commits. Mark it ready only when the
required pre-merge checks pass and a complete review of the pushed content has no open findings.
Approved fixes the user accepts without a new review count as reviewed.

## Hard rules

- Push, create or edit a PR, or change its draft status only after the user approves the preview.
  Any change after approval needs a new preview.
- Ask every question with the `ask_user_question` tool, including the preview approval, the review's
  approval question, and the bot choice. Never end a turn with a question in prose.
- Follow the push rules in the [update-branch skill](../update-branch/SKILL.md). Never rebase or
  force-push unless the user asks. In a stack, step 5 restacks the branches above the PR's branch
  locally, and the preview approval covers their force-push.
- Commit with the [commit skill](../commit/SKILL.md). Never stash, discard, or commit changes that
  are not the task's. Ask when ownership is unclear, or when changes outside the task could affect
  the review or checks.
- Do not fix review findings or failing checks without the user's approval. Do not rerun a review
  after fixes on your own.
- On an update, keep title and body text you did not write in this session. Change only facts that
  are now wrong or missing, and show each change in the preview. Step 7 decides the body's
  structure.
- If a step fails partway, stop and report what completed. Read the remote branch and the PR before
  you retry anything.
- Do not watch CI, wait for reviews, request human reviewers, or merge.
- Before you save the first file, create a fresh directory inside an ignored `.tau/` from the
  repository root. Stop unless it prints `prdir=`, and use the printed path as `$prdir` for every
  file you save. Like code-review's setup, it refuses symlinks that would send writes outside the
  repository. Never write scratch files to `/tmp` or another shared path: other sessions run at the
  same time. Shell variables do not survive between commands, so repeat the printed path.

  ```sh
  ! [ -L .tau ] && ! [ -L .tau/pr ] && ! [ -L .tau/.gitignore ] &&
    mkdir -p .tau/pr &&
    { grep -qsx '\*' .tau/.gitignore || printf '\n*\n' >> .tau/.gitignore; } &&
    prdir=$(mktemp -d .tau/pr/run-XXXXXX) &&
    git check-ignore -q "$prdir/body.md" && echo "prdir=$prdir"
  ```

## Procedure

1. Resolve the target. Ask when any part is unclear.
   - Determine the GitHub host from the target repository URL or Git remote. Before other `gh`
     calls, run `gh auth status --active --hostname <host>`. If it fails, tell the user and stop.
   - Stop on a detached HEAD or on the default branch.
   - Head: the push target from `git rev-parse --abbrev-ref @{push}`, the remote the user names, or
     the sole remote with the local branch name. Base repository: the upstream of a fork, otherwise
     the push remote's repository. Use `<host>/<owner>/<name>` for the repository, and pass
     `--repo <repo>` to repository-scoped `gh` commands.
   - Find the PR with
     `gh pr list --repo <repo> --head <branch> --state all --json number,url,state,title,body,baseRefName,isDraft,headRefOid,headRepositoryOwner`,
     keeping only PRs from the head owner. Stop on a `gh` error. Use the open PR. When only merged
     or closed PRs match, ask.
   - Base branch: the open PR's base, the base the user names, the parent branch when the
     [stack skill](../stack/SKILL.md) finds the branch in a stack, or the default branch. Fetch it
     and pin the merge base with `git merge-base <remote>/<base> HEAD`.
   - Read linked issues from the user, the branch name, commits, and the existing body with the CLI
     that serves them. Use the returned issue IDs, not branch aliases. Note issues you cannot read.

2. Commit the task's uncommitted changes and any release notes the repository requires, such as a
   `.changeset` file. Name other changes in the summary.

3. Check the comments the branch adds since the merge base. Do this yourself; it does not block the
   PR. Read each file by its language's comment syntax, including whole block and doc comments.
   Quote each comment exactly with its `file:line`. Judge it against "Comment only what the code
   cannot say" in the [coding instructions](../../src/extensions/coding/instructions.md), or the
   repository's own comment rules. Remove only the comments that fail, commit the removal, and
   report each removal in the summary, not in the PR body. Repeat for comments added by later
   commits before the preview.

4. Review the pushed content: the range `<merge base>..HEAD` with both ends pinned. Reuse an earlier
   code review only when all of these hold:
   - The session or its saved files under `.tau/workers/review-*/` show that every worker reported
     (`reviewer.md`, or `finder.md` and `checker.md`), the freshness check passed, and no gaps
     remain besides areas a worker read shallowly. A status that the evidence does not state is
     unknown, so do not reuse.
   - Its base is the pinned merge base, and it covered the whole branch.
   - Its capture matches the content. Use the saved `recheck.diff` and confirm that its
     `git hash-object` equals the recorded capture hash. Split it and
     `git diff --no-ext-diff --no-color <merge base> HEAD` at each `diff --git` line. Each path must
     have a byte-identical section, including mode, deletion, rename, and binary lines, and neither
     side may have extra paths. Order does not matter, so committed untracked files and new commits
     with the same content still match.
   - Callers and rules outside the capture have no relevant changes.

   When you cannot establish one of these, run the `code-review` skill in fast mode on the range
   instead. If it or its worker tools are missing, report a gap and do not review in its place. Ask
   its approval question for findings. Step 6 decides what approved fixes need.

5. Run checks. Reuse a passing result of the required pre-merge checks when evidence shows it ran on
   the same content, as
   [ADR 0039](../../docs/adr/0039-reuse-reported-checks-and-run-one-full-suite.md) describes.
   Otherwise commit the task's changes first and run them once on that tree. In a stack, first
   restack the branches above with the [stack skill](../stack/SKILL.md). Then run the checks on the
   PR's branch and on each branch above that the restack changed, since step 9 pushes them all.
   After any later commit, restack and run the affected checks again before the preview. Save their
   real output in `$prdir`, with the HEAD, `git status --porcelain`, and the hash of
   `git diff <merge base> HEAD`, taken before the run, at the top. Never write a summary in its
   place. A failing check is a gap.

6. Choose the draft status. Ready needs passing required checks and a complete review with no open
   findings that matches the pushed content, apart from approved fixes the user accepted without a
   review. A finding is closed only when fixed and reviewed again, when the user accepts its fix
   without a review, or when the user dismissed it as not a defect; record their reason in the
   summary. When commits after the review leave it as the only gap, ask once: accept the approved
   fixes without a review, run a new fast review, or open as draft. Offer acceptance only when those
   commits are approved fixes. After a new review, choose again with its result. A finding the user
   defers or leaves unfixed stays open. Only checks that can run solely after deployment are
   deferred instead of gaps. Any gap means draft. Areas a worker read shallowly are notes for the
   summary, not gaps. For an existing ready PR with a gap, offer to convert it to draft.

7. Write the title and body. For a new PR, or an update whose body does not follow the template, use
   the repository's template: look case-insensitively for `pull_request_template.md` in the root,
   `.github/`, `docs/`, or a `PULL_REQUEST_TEMPLATE/` directory, and ask when more than one fits.
   Otherwise use the [fallback template](fallback-template.md). Ask before you restructure a body
   that has text you did not write in this session, and keep that text. Match the title to the
   repository's convention. Write `Fixes <issue>` only for an issue this PR completes, and
   `Related to <issue>` for the rest. State the review's result, open findings, and fixes accepted
   without a review in the body, and keep reviewer notes, worker names, and local paths for the
   summary. Write commit SHAs in full as plain text, never in backticks. Save the body as
   `$prdir/body.md`.

8. Preview and ask. Show the title, full body, base repository and branch, head, draft status,
   commits to push, and push command. In a stack, list every branch the push updates with its local
   SHA, and say that each one is force-pushed with a lease. Also show the `gh stack link` command,
   or why step 9 cannot link. Add the summary: commits made, comment findings and removals, review
   and check sources, reviewer notes, and gaps. Wait for approval.

9. Publish.
   - Compare HEAD, local status, and the commits to push with the preview, and read the PR again. In
     a stack, also compare each branch's SHA. If anything changed, stop, refresh the affected
     evidence, and show a new preview that keeps the new edits.
   - Push with `git push <remote> HEAD:refs/heads/<branch>`, adding `-u` for a new branch. In a
     stack, push the stack with the stack skill instead. If the push is rejected, stop and report.
   - Create with `gh pr create`, specifying the approved base, head, title, and `--body-file`;
     include `--draft` when approved as draft and `--head <owner>:<branch>` for a fork. Update with
     `gh pr edit`. Change an existing PR's draft status with `gh pr ready`, adding `--undo` for
     draft.
   - In a stack, after creating the PR, add it to the stack on GitHub with
     `gh stack link --remote <remote> --base <trunk> <PR numbers, bottom to top>`. Without `--base`,
     it sets the bottom PR's base to the default branch. Do not use `gh stack submit`: it publishes
     generated titles instead of the approved ones.
   - `link` only adds PRs to the top of a GitHub stack and never removes one. Read the stack that
     holds the PR below with
     `gh api --hostname <host> "repos/<owner>/<name>/stacks?pull_request=<number>" --jq '.[0].pull_requests | map(.number)'`.
     Pass those numbers, merged ones included, then the new PR. When no stack holds the PR below,
     pass the open PRs from `gh stack view --json`. A stack with one open PR needs no link. When the
     new PR is not the top of the local stack, do not link; report that GitHub can add it only at
     the top.
   - After linking, read the stack again with the new PR's number and check that it lists the
     numbers you passed, in order. `gh stack view --json` shows only the local stack, so it cannot
     confirm the link.

10. Verify. Compare
    `gh pr view <number> --repo <repo> --json url,title,body,baseRefName,isDraft,headRefOid` with
    the preview and local HEAD. GitHub drops the body's trailing newlines, so compare the body with:

    ```sh
    diff <(printf '%s\n' "$(gh pr view <number> --repo <repo> --json body -q .body)") \
      <(printf '%s\n' "$(cat <prdir>/body.md)")
    ```

    Report any difference and the PR URL. If verification fails or shows a difference, stop here.

11. Offer bot reviews. Publication approval does not cover them. Ask which bots to request, with an
    option to skip. Suggest the bots the repository documents or configures, such as CodeRabbit for
    a `.coderabbit.yaml`, or Codex when there are none.
    - For Codex, run `gh pr comment <number> --repo <repo> --body '@codex review'`. Use each other
      bot's documented trigger; do not invent one.
    - Read existing requests and reviews first. Do not repeat a request known to cover the current
      head, and ask when coverage is unclear.
    - Report which requests were sent and skipped, then stop. A posted request does not prove that a
      review started.
