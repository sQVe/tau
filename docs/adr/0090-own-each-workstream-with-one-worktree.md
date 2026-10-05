# ADR 0090: Own each workstream with one worktree

- Status: Accepted
- Date: 2026-10-05

## Context

- No rule says whether a worktree holds one branch or a whole stack, so agents cannot tell which one
  a folder follows.
- A stack's manager switches branches and rebases the whole stack. Git refuses to rebase a branch
  that another worktree has checked out, and `git rebase --update-refs` skips such branches.
- Workers share their manager's checkout. A branch switch under a running worker changes the files
  it edits.
- The user keeps some worktrees open in herdr after their PRs merge, to continue work or plan other
  work.

## Options considered

- One worktree per stacked slice. Rejected: the stack's owner could not restack branches checked out
  in other worktrees, so no single owner could keep the whole stack current.
- A pool of reusable worktrees that take a new branch when idle. Rejected: each reuse needs a reset
  step for ignored files, `.tau/`, and state keyed by path, before its savings are measured.
- One shared checkout for all work. Rejected: several managers would share one checkout, which
  breaks one owner per checkout.
- Remove each worktree automatically after its last PR merges. Rejected: the user keeps merged
  worktrees open for follow-up work and planning, and decides when each one goes.
- One worktree per workstream, removed by the user. Chosen: it keeps today's layout and adds the
  ownership rules it lacks.

## Decision

A worktree holds one workstream. A workstream is one standalone slice or one whole stack of slices.

### Ownership

- One worktree, one manager, and one herdr workspace own a workstream.
- A stack stays in one worktree. Its manager switches between the stack's branches.
- The manager switches branches, restacks, or syncs only on a clean tree and when every one of its
  workers in the worktree has stopped.
- [ADR 0075](./0075-plan-work-as-pr-sized-slices-in-linear.md) maps one slice to one branch and one
  PR, not to one folder.

### Removal

- A worktree may stay after its workstream's last PR merges.
- The user removes worktrees by hand, such as with `grove prune --herdr`. No skill removes them.

## Tradeoffs

- Each folder has one owner and one purpose that an agent can name.
- One owner can restack the whole stack, because no other worktree holds its branches.
- The user keeps a merged worktree and its herdr workspace for as long as they need it.
- Cost: work on one slice of a stack waits while the manager works on another branch of it.
- Cost: workers wait or stop before each branch switch in a stack.
- Cost: idle worktrees pile up until the user removes them.

## See also

- [ADR 0075](./0075-plan-work-as-pr-sized-slices-in-linear.md) for slices, branches, and PRs.
