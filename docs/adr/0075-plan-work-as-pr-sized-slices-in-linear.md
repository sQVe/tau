# ADR 0075: Plan work as PR-sized slices in Linear

**Date**: 2026-09-30\
**Status**: Accepted

## Context

A manager and its workers carry out an agreed design across many sessions. A plan kept only in the
manager's context is lost when the session ends. One large PR is hard to review in one sitting. A
plan that fixes every step up front goes stale when earlier work changes the code. Linear already
holds human tickets, so the plan needs a shape there that maps cleanly to branches, PRs, and
closing.

## Decision

Plan each agreed design as an ordered list of slices, where one slice is exactly one branch and one
PR against `main`. Agent tickets are created when their slice starts. Every ticket then maps to one
branch or one worker task, and each detailed plan meets the current code.

### Lifecycle

1. The user and the manager agree on a design.
2. The manager splits the design into slice tickets under a container. The user approves the split
   in one preview before anything is written to Linear.
3. The manager starts one slice at a time: it creates the slice branch and the slice's agent
   tickets. The user approves each slice start once.
4. Workers do the agent tickets, and the slice goes through review, a PR, and merge. Then the next
   slice starts, unless it already started stacked on this one.

### Tickets

- Container: the human ticket. Its description holds the agreed design. A design with one slice gets
  no container; the ticket is the slice.
- Slice: a human sub-ticket of the container in the same team. It is the smallest piece worth its
  own PR, leaves `main` working, and fits one review sitting. The PR says `Fixes <slice>`.
- Agent ticket: a sub-ticket of its slice in the agent team, with an outcome, files, a first test,
  and acceptance checks. It is written against the code when its slice starts. The branch always
  comes from the slice, never from an agent ticket.

### Order and changes

- Create slices in order. Put groundwork in an earlier slice. Add `blocked-by` only for a real
  dependency.
- A slice that depends on an unmerged slice may stack on it instead of waiting.
- The manager may add agent tickets inside a slice's approved outcome, each with a one-line reason.
  Work beyond that outcome becomes a new slice through a new split preview.
- Merged slices never change.

### Closing

- Merging a slice's PR closes only that slice. Linear should close its agent tickets with it.
- A Done status is not proof. Compare the acceptance checks and the PR state.
- The container closes by hand once every slice is done.

## Consequences

### Positive

- The plan survives the session in Linear, and each PR maps to exactly one ticket.
- Detailed plans stay current, because agent tickets are written just before the work.
- The user approves at two fixed points: the split and each slice start.

### Negative

- A design split into many slices makes many PRs, each with its own review and check run.
- Later slices are planned only roughly until they start, so their size can change.
- Agent tickets live in a second team, so the manager reads two teams to see progress.

## Alternatives considered

### Slices mapped to PRs by size

Map slices to PRs by size, so one PR may cover several slices. Rejected because it needs extra
mapping and closing rules.

### Plan layer of AI tickets

Add a plan layer of AI tickets between the human ticket and the slices. Rejected because it adds one
more state to reconcile with the tickets it describes.

### Task text only

Put worker instructions only in the task text, with no agent tickets. Rejected because progress is
lost across sessions.

### All agent tickets at the split

Create all agent tickets when the design is split. Rejected because they go stale as earlier slices
change the code.
