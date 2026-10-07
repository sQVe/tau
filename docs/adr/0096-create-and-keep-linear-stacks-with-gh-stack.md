# ADR 0096: Create and keep linear stacks with gh stack

**Date**: 2026-10-07\
**Status**: Accepted\
**Related**: [ADR 0075 (Plan work as PR-sized slices in Linear)](./0075-plan-work-as-pr-sized-slices-in-linear.md),
[ADR 0090 (Own each workstream with one worktree)](./0090-own-each-workstream-with-one-worktree.md)

## Context

A slice may stack on an unmerged slice instead of waiting. When the skills only detect stacks,
agents chain branches by hand with `git rebase` and `--base`. Such chains drift: a PR's diff holds
its parent's commits, two PRs share one parent, and a restack onto the trunk keeps commits that were
already squash-merged.

`gh stack` tracks a stack as one line of branches. It adds a branch only at the top, and its rebase
drops the commits of merged PRs only for branches it tracks. It keeps its state per worktree, so a
missing local stack does not prove that a branch is outside one.

## Decision

Skills create, restack, and push every stack through `gh stack`, and a stack stays one line of
branches.

### Creating and keeping stacks

- A slice whose blockers have open PRs starts stacked only when those blockers sit in one chain. It
  starts with `gh stack add` on the top of the parent's stack, or `gh stack init` for a parent in no
  stack.
- When the parent already has a branch above it, the slice waits for the parent to merge. Stacking
  on the top of that stack instead needs the user's approval, because it adds a dependency.
- A branch in a stack is never rebased with plain `git rebase`. A stack check that cannot decide
  stops the skill instead of counting as no stack.
- No skill moves the local trunk by hand. `gh stack rebase` and `gh stack sync` move it when Git
  allows and rebase onto the remote trunk otherwise.

### Pull request bases

A base that the caller passes to the `pr` tool wins over the open PR's current base. The `pr` skill
passes the stack parent and changes the PR's base when it differs, so a stacked PR's diff holds only
its own commits.

## Consequences

### Positive

- One tool owns stack state, so restacks drop merged commits, squash merges included.
- Each PR's base names its parent, and each PR shows only its own commits.

### Negative

- A slice whose dependencies branch and join cannot always stack. It waits for its blockers to
  merge.
- A stack check reads GitHub as well as local state, which adds reads before each create, rebase,
  and push.

## Alternatives considered

### Chain branches by hand with `--base`

Create each branch from its parent and set the PR base with `--base`. Rejected because nothing then
tracks the chain, so a later rebase onto the trunk replays squash-merged commits and bases drift.

### Fork a stack into several stacks

Let two slices stack on the same parent, each in its own stack. Rejected because `gh stack` adds
only at the top, and each restack of the shared parent would have to be repeated in every stack.

### Keep an open PR's base over a newly found parent

Leave a published PR's base alone and stack only new PRs. Rejected because a PR created before its
parent was known keeps the trunk as its base, and its diff then holds the parent's commits.
