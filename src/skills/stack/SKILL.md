---
name: stack
description:
  Check, create, switch, restack, and push a stack of GitHub pull requests with `gh stack`. Other
  skills run its stack check before they create, rebase, or push a branch. Use it for "restack",
  "rebase the stack", "push the stack", "stack this on ENG-123", "switch to PR 3 in the stack", or
  when a lower PR in a stack merged.
metadata:
  required-for: running gh stack commands, including as a step in a larger task
---

# Stack

## When to use

Use this skill when a branch belongs to a stack, or when another skill sends you here. It needs the
`gh stack` extension and `gh` authenticated for the repository's host.

## Hard rules

- Run every `gh stack` command non-interactively with explicit arguments. Pass `--remote <remote>`
  to `rebase`, `push`, `sync`, `submit`, and `link`, because without it they stop when several
  remotes exist. Never run `gh stack checkout` without an argument: it opens a picker. Never use
  `switch` or `modify`: both are interactive.
- Never run a plain `git rebase` on a branch in a stack, the bottom branch included. Restack it with
  step 4.
- Never update the local trunk by hand, such as with `git pull` on it or
  `git fetch <remote> <trunk>:<trunk>`. Git refuses when the trunk is checked out in another
  worktree. `gh stack rebase` and `gh stack sync` fetch the trunk and move it when they can.
- Name the trunk from the stack's `trunk` or the repository's default branch, never a literal
  `main`.
- Never work out a stack from PR bases yourself. Step 1 tells you when PRs are chained without
  tracking.
- Switch, create, restack, or sync only on a clean working tree and when every one of your workers
  in the worktree is `stopped`. Workers share its files, so a branch change moves them under a live
  worker. Find your workers with `subagent_history`, following `nextOffset` through every page, and
  read each state with `subagent_status`. Any other state, or a state you cannot read, blocks the
  change: wait for the worker, or ask the user before you cancel it.
- Follow the rebase, abort, and push rules in the [update-branch skill](../update-branch/SKILL.md).

## Procedure

1. Stack check. Run it on the current branch before you create, rebase, or push it. It ends in one
   of four results: tracked, untracked, standalone, or unknown.
   - Run `gh stack view --json`. It prints
     `{trunk, currentBranch, branches: [{name, head, base, isCurrent, isMerged, isQueued, needsRebase, pr: {number, url, state}}]}`,
     with branches ordered bottom to top. `head` and `base` are commit SHAs, and `base` can be
     stale. Exit code 0 means tracked.
   - The branch's parent is the nearest branch below it whose `isMerged` is false, or `trunk` when
     none is. Its PR's base must be that parent.
   - Exit code 6 means the branch belongs to several stacks. Check out a non-trunk branch first, or
     ask.
   - Exit code 2 does not prove the branch is outside a stack. Stack state lives per worktree in
     `$(git rev-parse --git-dir)/gh-stack`, so a stack tracked in another worktree, or only on
     GitHub, does not show here. Read GitHub next:
     - The branch's open PR:
       `gh pr list --repo <repo> --head <branch> --state open --json number,url,baseRefName`.
     - Open PRs based on the branch:
       `gh pr list --repo <repo> --base <branch> --state open --json number,headRefName`.
     - For an open PR, the GitHub stack that holds it:
       `gh api --hostname <host> "repos/<owner>/<name>/stacks?pull_request=<number>" --jq '(.[0].pull_requests // []) | map(.number)'`.
       It prints `[]` when no stack holds the PR. A 404 means the repository has no stacked PRs.
     - When the PR's base is not the default branch, the open PR of that base:
       `gh pr list --repo <repo> --head <baseRefName> --state open --json number,url`.
   - The result is untracked when a GitHub stack holds the PR, the PR's base has an open PR, or an
     open PR is based on the branch. When a GitHub stack holds it, import it with step 3 and run the
     check again. Otherwise stop and report the chain of PRs. Suggest
     `gh stack init --base <trunk> <branches, bottom to top>`, and run it only after the user
     approves.
   - The result is standalone when none of those hold.
   - Any other exit code, or a read that fails, means unknown. Stop and report it. Never treat
     unknown as standalone.

2. Create a branch on top of a parent branch, after the calling skill's approval. Run step 1's
   GitHub reads on the parent first. Stop when an open PR other than the new branch's is based on
   the parent: `gh stack add` adds only to the top of a stack, so a stack cannot fork. The calling
   skill decides what happens next.
   - Run `gh stack checkout <parent>`. Exit code 0 means the parent is in a stack, now tracked in
     this worktree and checked out. It imports a stack from GitHub as step 3 describes.
   - Exit code 2 means no local or GitHub stack holds the parent. Switch to it with
     `git switch <parent>`, or `git switch --no-track -c <parent> <remote>/<parent>` when it has no
     local branch. `gh stack init` would otherwise create the parent from the local trunk.
   - Run `git fetch <remote> <parent>`. When `git log --oneline <parent>..<remote>/<parent>` lists
     commits, fast-forward with `git merge --ff-only <remote>/<parent>`. Stop if that fails or if
     `git log --oneline <remote>/<parent>..<parent>` lists commits.
   - For a parent in a stack, check that `gh stack view --json` lists it as the top branch. Stop if
     a branch sits above it. Then run `gh stack add <branch>`.
   - For a parent in no stack, run `gh stack init --base <trunk> <parent> <branch>`. It adopts the
     parent and creates the branch from it.
   - Both adopt a branch that exists already, without rebasing it. Restack it with step 4.
   - Run `gh stack view --json` and check that the new branch is the top and the parent is directly
     below it.

3. Switch to a PR with `gh stack checkout <pr url>`. A URL always resolves to a PR, but a bare
   number is read as a stack number first.
   - If it reports that the local stack differs from the remote, stop and report both chains it
     prints.
   - It takes no `--remote`. To import a stack that is not tracked locally, it fetches from the
     remote that Git config sets for the trunk: `pushRemote` or `remote` of the trunk branch,
     `remote.pushDefault`, or `gh-stack.remote`. With several remotes and none of these set, it
     fails with "multiple remotes configured" in a non-interactive shell. Stop and report it. Do not
     change the config to get past it.

4. Restack.
   - Before the first rebase, run `git fetch --prune <remote>`, so the tracking refs of deleted
     branches drop out.
   - When a PR below the branch merged on GitHub, check that `gh stack view --json` shows its
     `isMerged` as true. Stop if it does not. The rebase reads merge state from GitHub and ignores a
     failed read, and it would then replay the commits of a squash-merged branch.
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
     merged and rebase the branch above them with `--onto` the first unmerged branch below, or the
     trunk, so the merged commits drop out, squash merges included.
   - Exit code 3 means a conflict. Resolve it as in step 4 of the update-branch skill, but stage the
     files and run `gh stack rebase --continue` instead of `git rebase --continue`.
   - A stack rebase is paused when `$(git rev-parse --git-dir)/gh-stack-rebase-state` exists, and
     exit code 7 also means one is in progress. HEAD is detached then, so step 1 cannot detect the
     stack. Resolve its conflicts the same way and finish it with `gh stack rebase --continue`,
     never `git rebase --continue`.
   - Abort a stack rebase with `gh stack rebase --abort` only with the user's permission. It
     restores every branch.

5. Push.
   - After any commit made since the last restack, restack again with step 4 and rerun the affected
     checks. The push does not restack, so the branches above would miss that commit.
   - Immediately before the push, run `git fetch --prune <remote>` again. Stop if any noted remote
     tip moved or is gone, or if a branch you noted as unpublished now has a remote tip.
   - Run `gh stack push --remote <remote>`. It force-pushes every active branch with a per-branch
     `--force-with-lease` and skips merged and queued branches. It takes its leases from its own
     fetch, so they protect only against changes pushed after that fetch, not the tips you noted.
   - The push is not atomic. If it fails, stop. Compare each branch with
     `git ls-remote <remote> refs/heads/<branch>` and report which branches updated and which did
     not.

6. Sync, only when the user asks for it or to push after a lower PR merged.
   - Sync rebases and force-pushes too. First run `git fetch --prune <remote>`, then the merge-state
     and remote-history checks from step 4 on every active branch, and stop if either fails. Sync
     needs the same push permission as step 5.
   - Run `gh stack sync --remote <remote>`. It fetches, rebases, pushes all branches atomically with
     a lease, and links the open PRs into the stack on GitHub.
   - When the local and remote stacks have diverged, it aborts without pushing in a non-interactive
     shell. Stop and report its output.
   - On a conflict it restores every branch. Restack with step 4 instead.
