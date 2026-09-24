---
name: update-branch
description:
  Rebase the current branch onto its base, resolve conflicts, and update the PR when asked. Use it
  for "rebase onto main", "fix conflicts", "the PR has conflicts", or when a rebase or merge stops
  on a conflict.
---

# Update branch

## When to use

Use this skill to start or continue a rebase in this session's worktree. For another worktree, use
the [handoff skill](../handoff/SKILL.md).

## Hard rules

- Do not stash, discard, or commit unrelated changes. Before starting a rebase, stop and ask if the
  working tree is dirty. During a rebase, change only the files its conflicts need.
- Do not abort the rebase without the user's permission.
- Ask when two changes need a product decision to fit together.
- Push only when the user asks to push, or to fix or update the remote PR. Otherwise leave the
  result local and say it is ready to push. A merged PR does not authorize pushing its branch.

## Procedure

1. Check the branch, `git status`, and whether a rebase is in progress. To continue an existing
   rebase, go to step 4 and ask if its target is unclear. Ask before pushing it unless you noted the
   remote tip before it started. If a merge is in progress, resolve its conflicts as in step 4, then
   finish with the [commit skill](../commit/SKILL.md) instead of `rebase --continue`.
2. Fetch the base's remote and, if different, the remote the branch pushes to. Note the SHA of the
   branch's remote tip if it has one: `git rev-parse <remote>/<branch>`. Stop if fetching or
   resolving fails, or if `git log --oneline HEAD..<old-tip>` lists commits missing locally.
3. Rebase onto the base's fetched remote-tracking branch, such as `git rebase origin/main`.
4. For each conflict, read both changes and enough surrounding code to understand their intent.
   Consult linked PRs or issues only when intent stays unclear. Keep both intents where they fit.
   Stage resolved files by name, then run `GIT_EDITOR=true git rebase --continue`. Skip a commit
   only after checking that its change is already in the rebased history. An empty diff alone is not
   proof.
5. Run the project's required checks. If you fix a failure, commit the fix with the
   [commit skill](../commit/SKILL.md), then rerun the affected checks and any required final check.
6. When pushing is authorized:
   `git push <remote> HEAD:refs/heads/<branch> --force-with-lease=refs/heads/<branch>:<old-tip>`. If
   the lease fails, stop and report. Do not refresh it to retry. If the remote branch does not exist
   yet, push without a lease, and only when the user asked for it.
