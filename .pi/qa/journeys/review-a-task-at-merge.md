# Review a task at merge

## Who

The Tau user.

## Goal

Learn from a task that went badly while it is fresh.

## Test

By hand, because it reads live logs under `~/.pi/agent/` and `gh`.

## Steps

1. Merge a pull request whose task has a signal, such as 3 or more PR feedback rounds, with
   `gh pr merge --auto`.
   The session says the pull request merged, names the signal, and offers a review of this task.
2. Accept. One reviewer worker starts. The session shows a TLDR of at most five lines, then an
   Accepted table of at most 5 rows with problem, proposal, route, and evidence marked Verified,
   then Rejected and Backlog lists, and an Attention section.
3. Approve, reject, or redirect each row. For each approved row, a new tab opens in a worktree of
   the owning project, with the proposal as its task.

## End state

Each approved row has a worktree tab whose session files a ticket. A run with no supported problem
ends as clean, with no rows.
