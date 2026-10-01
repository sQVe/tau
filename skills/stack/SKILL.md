---
name: stack
description:
  Detect, switch, restack, and push a stack of GitHub pull requests with `gh stack`. Other skills
  call it when the branch is in a stack. Use it for "restack", "rebase the stack", "push the stack",
  "switch to PR 3 in the stack", or when a lower PR in a stack merged.
---

# Stack

## When to use

Use this skill when a branch belongs to a stack that `gh stack` tracks, or when another skill sends
you here. It needs the `gh stack` extension and `gh` authenticated for the repository's host.

## Hard rules

- Run every `gh stack` command non-interactively with explicit arguments. Pass `--remote <remote>`
  to `rebase`, `push`, `sync`, `submit`, and `link`. Without it they stop when several remotes
  exist. Never run `gh stack checkout` without an argument: it opens a picker. Never use `switch` or
  `modify`: both are interactive.
- A stack that `gh stack` does not track, such as PRs chained by hand with `--base`, is a set of
  standalone PRs. Do not work out a stack from the bases yourself. When a PR's base is not the
  default branch, suggest `gh stack init <branches, bottom to top>` to start tracking it.
- Change branches only on a clean working tree. Follow the rebase, abort, and push rules in the
  [update-branch skill](../update-branch/SKILL.md).

## Procedure

1. Detect. Run `gh stack view --json` on the current branch. It prints
   `{trunk, currentBranch, branches: [{name, head, base, isCurrent, isMerged, isQueued, needsRebase, pr: {number, url, state}}]}`,
   with branches ordered bottom to top. `head` and `base` are commit SHAs. A branch's parent branch
   is the previous entry's `name`, or `trunk` for the bottom branch. Exit code 2 means the branch is
   not in a stack, so treat it as a standalone branch. Exit code 6 means the branch belongs to
   several stacks: check out a non-trunk branch first, or ask.

2. Switch to a PR with `gh stack checkout <pr url>`. A URL always resolves to a PR. A bare number is
   read as a stack number first. If it reports that the local stack differs from the remote, stop
   and report both chains it prints.

3. Restack. From the branch you changed, run `gh stack rebase --upstack --remote <remote>`. It
   rebases that branch onto its parent and each branch above onto the one below it. To bring the
   whole stack up to date with the trunk, run `gh stack rebase --remote <remote>`. Both fetch the
   stack's branches first and fast-forward the ones behind their remote. Branches whose PRs merged
   are skipped, and the branch above them is rebased onto the first unmerged branch below or onto
   the trunk, so the merged commits drop out.
   - Exit code 3 means a conflict. Resolve it as in step 4 of the update-branch skill, but stage the
     files and run `gh stack rebase --continue` instead of `git rebase --continue`. Abort with
     `gh stack rebase --abort` only with the user's permission. It restores every branch.
   - Exit code 7 means a stack rebase is already in progress. Resolve its conflicts the same way and
     finish it with `gh stack rebase --continue`, never `git rebase --continue`. Abort it with
     `gh stack rebase --abort` only with the user's permission.

4. Push. Before the rebase, note each active branch's remote tip with
   `git rev-parse <remote>/<branch>`. Immediately before the push, fetch again and stop if any
   remote tip moved. Then run `gh stack push --remote <remote>`. It fetches again and takes its
   leases from that fetch, so the lease protects only against changes pushed after its own fetch. It
   does not guarantee that the remote still holds the tips you noted. It force-pushes every active
   branch with a per-branch `--force-with-lease` and skips merged and queued branches. The push is
   not atomic. If it fails, stop. Compare each branch with
   `git ls-remote <remote> refs/heads/<branch>` and report which branches updated and which did not.

5. Sync, only when the user asks for it or to push after a lower PR merged. Run
   `gh stack sync --remote <remote>`. It fetches, rebases, pushes all branches atomically with a
   lease, and links the open PRs into the stack on GitHub. It is a push, so it needs the same
   permission as step 4. When the local and remote stacks have diverged, it aborts without pushing
   in a non-interactive shell; stop and report its output. On a conflict it restores every branch;
   restack with step 3 instead.
