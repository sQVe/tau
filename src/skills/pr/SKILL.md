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
- Ask every question with `ask_user_question`, including review approval, preview approval, and bot
  choice. Never ask in prose. If the dialog closes without an answer, state the blocked decision and
  stop. Closing the dialog is not approval.
- Follow the push rules in the [update-branch skill](../update-branch/SKILL.md). Except for stack
  restacking in step 5, never rebase or force-push unless the user asks. Step 5 restacks locally;
  preview approval covers the stack's force-push.
- Commit with the [commit skill](../commit/SKILL.md). Never stash, discard, or commit unrelated
  changes. Ask when ownership is unclear or unrelated changes could affect review or checks.
- Fix review findings or failing checks only with the user's approval. Rerun a review after fixes
  only when the user chooses that in step 6.
- On updates, keep title and body text you did not write this session. Change only wrong or missing
  facts, and preview each change.
- After a partial failure, stop and report what completed. Read the remote branch and PR before
  retrying.
- Do not watch CI, wait for reviews, request human reviewers, or merge.
- Before saving any file, run this from the repository root. Stop unless it prints `prdir=`. Use
  that path as `$prdir` for every saved file, and repeat it in each command; shell variables do not
  survive between commands. Never use `/tmp` or another shared path: other sessions run at the same
  time.

  ```sh
  ! [ -L .tau ] && ! [ -L .tau/pr ] && ! [ -L .tau/.gitignore ] &&
    mkdir -p .tau/pr &&
    { grep -qsx '\*' .tau/.gitignore || printf '\n*\n' >> .tau/.gitignore; } &&
    prdir=$(mktemp -d .tau/pr/run-XXXXXX) &&
    git check-ignore -q "$prdir/body.md" && echo "prdir=$prdir"
  ```

## Procedure

1. Resolve the target. Ask when unclear.
   - Determine the GitHub host from the repository URL or Git remote. Before other `gh` calls, run
     `gh auth status --active --hostname <host>`. On failure, tell the user and stop.
   - Stop on a detached HEAD or the default branch.
   - Head: the push target from `git rev-parse --abbrev-ref @{push}`, the user-named remote, or the
     sole remote with the local branch name. Base repository: a fork's upstream, otherwise the push
     remote's repository. Use `<host>/<owner>/<name>` and pass `--repo <repo>` to repository-scoped
     `gh` commands.
   - Find the PR with
     `gh pr list --repo <repo> --head <branch> --state all --json number,url,state,title,body,baseRefName,isDraft,headRefOid,headRepositoryOwner`.
     Keep only the head owner's PRs. Stop on error. Use the open PR; ask if only merged or closed
     PRs match.
   - Base: the open PR's base, the user-named base, the parent found by the
     [stack skill](../stack/SKILL.md), or the default branch. Fetch it and pin the merge base with
     `git merge-base <remote>/<base> HEAD`.
   - Read issues linked by the user, branch name, commits, and existing body with their service's
     CLI. Use returned issue IDs, not branch aliases. Note unreadable issues.

2. Commit the task's changes and required release notes, such as a `.changeset` file. List unrelated
   changes in the session report.

3. Check comments added since the merge base yourself. This does not block the PR.
   - Read each file using its language's comment syntax, including whole block and doc comments.
     Quote each comment exactly with `file:line`.
   - Apply "Comment only what the code cannot say" in the
     [coding instructions](../../instructions/coding.md), or the repository's comment rules.
   - Remove only failing comments and commit the removal. Report each removal in the session report,
     not the PR body. Repeat for comments added by later commits before previewing.

4. Review `<merge base>..HEAD`, with both ends pinned. Reuse an earlier review only if:
   - The session or saved `.tau/workers/review-*/` files show every worker reported (`reviewer.md`,
     or `finder.md` and `checker.md`), freshness passed, and no gaps remain besides areas a worker
     read shallowly. Unstated status is unknown; do not reuse it.
   - Its base is the pinned merge base, and it covered the whole branch.
   - Its saved `recheck.diff` has the recorded capture hash from `git hash-object`. Split it and
     `git diff --no-ext-diff --no-color <merge base> HEAD` at each `diff --git` line. Each path's
     section must be byte-identical, including mode, deletion, rename, and binary lines. Neither
     side may have extra paths. Ignore path order: committed untracked files or new commits with
     unchanged content can still match.
   - Callers and rules outside the capture have no relevant changes.

   Otherwise run the [code-review skill](../code-review/SKILL.md) in fast mode on the range. If the
   skill or worker tools are missing, report a gap; do not review in their place. Ask its approval
   question for findings.

5. Run checks. Reuse passing required pre-merge checks only with evidence of matching content.
   Otherwise run them once on the committed tree.
   - In a stack, first restack branches above with the stack skill. Check the PR's branch and every
     branch above changed by restacking, because step 9 pushes them all. After later commits,
     restack and rerun affected checks before previewing.
   - Save real output in `$prdir`, never a summary. At the top, record HEAD,
     `git status --porcelain`, and the hash of `git diff <merge base> HEAD`, taken before the run.

6. Choose draft status. Any gap means draft. A gap is one of:
   - A required check that failed or did not run. Only checks that can run solely after deployment
     are deferred instead of gaps.
   - A review that does not cover the pushed content. Approved fixes the user accepted without a new
     review count as covered.
   - An open finding. A finding closes when it is fixed and reviewed again, when the user accepts
     its fix without review, or when the user dismisses it as not a defect. Record the dismissal
     reason in the session report. Deferred or unfixed findings stay open.

   Areas a worker read shallowly are session-report notes, not gaps. If post-review commits make
   review coverage the only gap, ask once: run a new fast review or open as draft. Offer to accept
   the commits without review only when all of them are approved fixes. After a new review, choose
   status again. For an existing ready PR with a gap, offer conversion to draft.

7. Write the title and body. Save the body as `$prdir/body.md`.
   - Template: for a new PR or a body not following the template, find `pull_request_template.md`
     case-insensitively in the root, `.github/`, `docs/`, or a `PULL_REQUEST_TEMPLATE/` directory.
     Ask if several fit. Without one, use the [fallback template](fallback-template.md). Ask before
     restructuring text you did not write this session, and keep it.
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
   - In a stack, list each branch to push with its local SHA and explain that each is force-pushed
     with a lease. Show the `gh stack link` command, or why step 9 cannot link.
   - Include the session report: commits made, comment removals, review and check sources, reviewer
     notes, dismissed findings with their reasons, and gaps.

9. Publish.
   - Compare HEAD, local status, and commits to push with the preview; read the PR again. In a
     stack, compare each branch's SHA too. If anything changed, stop, refresh affected evidence, and
     preview again without losing new edits.
   - Push with `git push <remote> HEAD:refs/heads/<branch>`; add `-u` for a new branch. In a stack,
     use the stack skill instead. Stop and report a rejected push.
   - Create with `gh pr create`: specify approved base, head, title, and `--body-file`. Add
     `--draft` for approved draft status and `--head <owner>:<branch>` for a fork. Update with
     `gh pr edit`. Change existing draft status with `gh pr ready`, adding `--undo` for draft.
   - After creating a stacked PR, link with
     `gh stack link --remote <remote> --base <trunk> <PR numbers, bottom to top>`. Keep `--base`;
     omitting it sets the bottom PR's base to the default branch. Never use `gh stack submit`, which
     publishes generated titles instead of approved ones.
   - `link` only appends to the top of a GitHub stack; it never removes PRs. Read the stack holding
     the PR below with
     `gh api --hostname <host> "repos/<owner>/<name>/stacks?pull_request=<number>" --jq '.[0].pull_requests | map(.number)'`.
     Pass its numbers, including merged PRs, then the new PR. If none exists, pass open PRs from
     `gh stack view --json`. One open PR needs no link. If the new PR is not the local stack's top,
     do not link; report GitHub's top-only limit.
   - Read the remote stack again using the new PR's number. Check the passed numbers and their
     order. `gh stack view --json` reads only the local stack and cannot confirm linking.

10. Check the published PR. Compare
    `gh pr view <number> --repo <repo> --json url,title,body,baseRefName,isDraft,headRefOid` with
    the preview and local HEAD. GitHub drops trailing body newlines, so compare the body with:

    ```sh
    diff <(printf '%s\n' "$(gh pr view <number> --repo <repo> --json body -q .body)") \
      <(printf '%s\n' "$(cat <prdir>/body.md)")
    ```

    Report differences and the PR URL. Stop if the check fails or shows a difference.

11. Offer bot reviews with a skip option. Publication approval does not cover them. Suggest bots
    documented or configured by the repository, such as CodeRabbit for `.coderabbit.yaml`, or Codex
    if none exist.
    - Read existing requests and reviews first. Skip requests known to cover the current head; ask
      when coverage is unclear.
    - For Codex, run `gh pr comment <number> --repo <repo> --body '@codex review'`. Use documented
      triggers for other bots; never invent them.
    - Report sent and skipped requests, then stop. Posting a request does not prove a review
      started.
