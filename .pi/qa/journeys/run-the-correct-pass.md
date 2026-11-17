# Run the correct pass

## Who

The Tau user.

## Goal

Turn mistakes that repeat across tasks into checks.

## Test

By hand, because it reads live logs under `~/.pi/agent/` and `gh`.

## Steps

1. See `correct due` in the status bar. Run `/retrospective correct` in any manager session.
2. Read the report: a TLDR, the three measures with their coverage, then at most 5 classes. Each
   class shows its occurrences, the level picked (architecture, type, lint, test, prose), why a
   higher level does not work, and the past mistake its check must fail on.
3. Approve, reject, or redirect each class. Approved classes open worktree tabs, as in
   [review a task at merge](review-a-task-at-merge.md) step 3.

## End state

`correct due` is gone from the status bar. A rejected class does not return without a new
occurrence.
