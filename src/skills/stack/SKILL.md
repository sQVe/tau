---
name: stack
description:
  Detect, switch, restack, and push a stack of GitHub pull requests with `gh stack`. Other skills
  call it when the branch is in a stack. Use it for "restack", "rebase the stack", "push the stack",
  "switch to PR 3 in the stack", or when a lower PR in a stack merged.
metadata:
  required-for: running gh stack commands, including as a step in a larger task
---

# Stack

## When to use

Use this skill when a branch belongs to a stack that `gh stack` tracks, or when another skill sends
you here. It needs the `gh stack` extension and `gh` authenticated for the repository's host.

## Hard rules

- Run every `gh stack` command non-interactively with explicit arguments. Pass `--remote <remote>`
  to `rebase`, `push`, `sync`, `submit`, and `link`, because without it they stop when several
  remotes exist. Never run `gh stack checkout` without an argument: it opens a picker. Never use
  `switch` or `modify`: both are interactive.
- Treat a stack that `gh stack` does not track, such as PRs chained by hand with `--base`, as a set
  of standalone PRs. Do not work out a stack from the bases yourself. When a PR's base is not the
  default branch, suggest `gh stack init <branches, bottom to top>` to start tracking it.
- Change branches only on a clean working tree. Follow the rebase, abort, and push rules in the
  [update-branch skill](../update-branch/SKILL.md).

## Procedure

1. Detect. Run `gh stack view --json` on the current branch. It prints
   `{trunk, currentBranch, branches: [{name, head, base, isCurrent, isMerged, isQueued, needsRebase, pr: {number, url, state}}]}`,
   with branches ordered bottom to top. `head` and `base` are commit SHAs. A branch's parent branch
   is the previous entry's `name`, or `trunk` for the bottom branch.
   - Exit code 2 means the branch is not in a stack. Treat it as a standalone branch.
   - Exit code 6 means the branch belongs to several stacks. Check out a non-trunk branch first, or
     ask.

2. Switch to a PR with `gh stack checkout <pr url>`. A URL always resolves to a PR, but a bare
   number is read as a stack number first.
   - If it reports that the local stack differs from the remote, stop and report both chains it
     prints.
   - It takes no `--remote`. To import a stack that is not tracked locally, it fetches from the
     remote that Git config sets for the trunk: `pushRemote` or `remote` of the trunk branch,
     `remote.pushDefault`, or `gh-stack.remote`. With several remotes and none of these set, it
     fails with "multiple remotes configured" in a non-interactive shell. Stop and report it. Do not
     change the config to get past it.

3. Restack.
   - Before the first rebase, run `git fetch --prune <remote>`, so the tracking refs of deleted
     branches drop out.
   - Run the remote-history check on each active branch, one that is not merged or queued. Note its
     remote tip with `git rev-parse --verify --quiet <remote>/<branch>`. When that prints nothing,
     note the branch as unpublished and skip the check for it. Otherwise check that
     `git log --oneline <branch>..<remote>/<branch>` lists nothing.
     - For a branch you rebased since its last push, with plain `git rebase` or an earlier restack,
       use its tip from before the first of those rebases in place of `<branch>`.
     - When it lists commits for a branch you have not rebased since its last push, and
       `git merge-base --is-ancestor <branch> <remote>/<branch>` succeeds, the branch is only behind
       its remote. Go on: `gh stack rebase` and `gh stack sync` fast-forward it.
     - Stop and report each other branch it lists commits for. The rebase skips a branch that has
       diverged from its remote, and the push would then overwrite those remote commits.
   - From the branch you changed, run `gh stack rebase --upstack --remote <remote>`. It rebases that
     branch onto its parent and each branch above onto the one below it. To bring the whole stack up
     to date with the trunk, run `gh stack rebase --remote <remote>` instead. Both fetch the stack's
     branches first and fast-forward the ones behind their remote. Both skip branches whose PRs
     merged and rebase the branch above them onto the first unmerged branch below, or onto the
     trunk, so the merged commits drop out.
   - Exit code 3 means a conflict. Resolve it as in step 4 of the update-branch skill, but stage the
     files and run `gh stack rebase --continue` instead of `git rebase --continue`.
   - A stack rebase is paused when `$(git rev-parse --git-dir)/gh-stack-rebase-state` exists, and
     exit code 7 also means one is in progress. HEAD is detached then, so step 1 cannot detect the
     stack. Resolve its conflicts the same way and finish it with `gh stack rebase --continue`,
     never `git rebase --continue`.
   - Abort a stack rebase with `gh stack rebase --abort` only with the user's permission. It
     restores every branch.

4. Push.
   - After any commit made since the last restack, restack again with step 3 and rerun the affected
     checks. The push does not restack, so the branches above would miss that commit.
   - Immediately before the push, run `git fetch --prune <remote>` again. Stop if any noted remote
     tip moved or is gone, or if a branch you noted as unpublished now has a remote tip.
   - Run `gh stack push --remote <remote>`. It force-pushes every active branch with a per-branch
     `--force-with-lease` and skips merged and queued branches. It takes its leases from its own
     fetch, so they protect only against changes pushed after that fetch, not the tips you noted.
   - The push is not atomic. If it fails, stop. Compare each branch with
     `git ls-remote <remote> refs/heads/<branch>` and report which branches updated and which did
     not.

5. Sync, only when the user asks for it or to push after a lower PR merged.
   - Sync rebases and force-pushes too. First run `git fetch --prune <remote>`, then the
     remote-history check from step 3 on every active branch, and stop if it fails. Sync needs the
     same push permission as step 4.
   - Run `gh stack sync --remote <remote>`. It fetches, rebases, pushes all branches atomically with
     a lease, and links the open PRs into the stack on GitHub.
   - When the local and remote stacks have diverged, it aborts without pushing in a non-interactive
     shell. Stop and report its output.
   - On a conflict it restores every branch. Restack with step 3 instead.
