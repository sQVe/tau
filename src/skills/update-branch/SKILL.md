---
name: update-branch
description:
  Rebase the current branch onto its base, resolve conflicts, and update the PR when asked. Use it
  for "rebase onto main", "fix conflicts", "the PR has conflicts", or when a rebase or merge stops
  on a conflict.
metadata:
  required-for: rebasing a branch or force-pushing it, including as a step in a larger task
---

# Update branch

## When to use

Use this skill to start or continue a rebase in this session's worktree. For another worktree, use
the [handover skill](../handover/SKILL.md).

## Hard rules

- Do not stash, discard, or commit unrelated changes. Before you start a rebase, stop and ask if the
  working tree is dirty. During a rebase, change only the files its conflicts need.
- Before starting or continuing a standalone rebase, require every one of your workers in this
  worktree to be `stopped`. Follow the [stack skill's worker check](../stack/SKILL.md#hard-rules),
  under "Switch, restack, or sync only". Any other state, or a state you cannot read, blocks the
  rebase: wait for the worker, or ask the user before cancelling it.
- Do not abort the rebase without the user's permission.
- Ask when two changes need a product decision to fit together.
- Never run a plain `git rebase` on a branch in a stack. Restack it with the
  [stack skill](../stack/SKILL.md).
- Never update the local default branch by hand. Rebase onto its remote-tracking branch.
- Push only when the user asks to push, or to fix or update the remote PR. Otherwise leave the
  result local and say it is ready to push. A merged PR does not authorize pushing its branch.

## Procedure

1. Check the branch, `git status`, and whether a rebase or merge is in progress.
   - When `$(git rev-parse --git-dir)/gh-stack-rebase-state` exists, a stack rebase is paused.
     Continue it with the [stack skill](../stack/SKILL.md), never with `git rebase --continue`.
   - When a standalone rebase is in progress, run the worker check in Hard rules before continuing.
     Then note the tip it started from. Read `orig-head` in
     `$(git rev-parse --git-path rebase-merge)` or, for the apply backend,
     `$(git rev-parse --git-path rebase-apply)`, whichever exists. Stop if neither holds it. Ask if
     the rebase's target is unclear. Then run the fetch and tip check of step 2 with the noted tip
     in place of `HEAD`, and go to step 4. Ask before you push the result unless you noted the
     branch's remote tip before the rebase started.
   - HEAD is detached until that rebase finishes, so the stack skill can check for a stack only
     then. If it finds the branch in a stack, restack the branches above with it before step 5. In
     its remote-history check for this branch, use the start tip you noted.
   - When a merge is in progress, resolve its conflicts as in step 4. Then finish it with the
     [commit skill](../commit/SKILL.md) instead of `rebase --continue`.
2. Run the stack skill's stack check before any other check or rebase.
   - Tracked: restack with the stack skill instead of `git rebase`, then go to step 5. Its
     remote-history check covers each branch, including branches GitHub rewrote after a lower PR
     merged.
   - Untracked or unknown: stop as the stack skill says. Never treat a failed check as no stack.
   - Standalone: fetch the base's remote and, if different, the remote the branch pushes to. If the
     branch has a remote tip, note its SHA as `<old-tip>`: `git rev-parse <remote>/<branch>`. Stop
     if a fetch or the SHA lookup fails, or if `git log --oneline HEAD..<old-tip>` lists commits
     missing locally.
3. Run the worker check in Hard rules, then rebase onto the base's fetched remote-tracking branch
   with `git rebase <remote>/<base>`. The base is the branch the user names, else the PR's
   `baseRefName`, else the default branch from `git symbolic-ref --short refs/remotes/<remote>/HEAD`.
4. For each conflict, read both changes and enough surrounding code to understand their intent. Read
   linked PRs or issues only when the intent stays unclear. Keep both intents where they fit. Stage
   resolved files by name, then run `GIT_EDITOR=true git rebase --continue`. Skip a commit only
   after you check that its change is already in the rebased history. An empty diff alone is not
   proof.
5. Run the project's required checks. If you fix a failure, commit the fix with the commit skill,
   then rerun the affected checks and any required final check. In a stack, restack with the stack
   skill after the commit and before the rerun.
6. Push only when pushing is authorized.
   - In a stack, push with the stack skill. It checks the noted remote tips right before the push,
     because its own lease does not use `<old-tip>`.
   - Otherwise push with
     `git push <remote> HEAD:refs/heads/<branch> --force-with-lease=refs/heads/<branch>:<old-tip>`.
     If the lease fails, stop and report. Do not refresh it to retry. If the remote branch does not
     exist yet, push without a lease, and only when the user asked for it.
