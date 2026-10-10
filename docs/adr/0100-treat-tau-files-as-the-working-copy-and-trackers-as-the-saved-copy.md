# ADR 0100: Treat `.tau/` files as the working copy and trackers as the saved copy

**Date**: 2026-10-10\
**Status**: Accepted\
**Extends**: [ADR 0045 (Keep worker records per Tau checkout and worktree files in `.tau/`)](./0045-keep-worker-records-per-checkout-and-worktree-files-in-tau.md),
the worktree files part

## Context

Tau now keeps drafts of tickets, slices, pull requests, and review feedback in `.tau/` folders such
as `slices/`, `pr/`, and `pr-feedback/`. Linear and GitHub hold the same items after they are saved.
Two copies of one item can disagree, and nothing says which one a reader should trust.

Run state, such as a worker's session or a handover message, is short lived. A decision that exists
only there is lost when the session ends. ADR 0045 says Tau writes nothing else in a worktree, which
no longer matches these folders.

## Decision

Files in `.tau/` are the working copy, and Linear and GitHub hold the saved copy.

A tool saves the working copy to a tracker only after the user approves a preview of what it will
save. Once a saved copy exists, it wins over the working copy. This keeps one source of truth after
the first save, and it keeps edits made in the tracker by other people.

Run state is never the only copy of a decision. A decision goes into a working copy or a tracker. A
handover links to working copies or tickets and is not a record itself.

This updates ADR 0045. Its claim that Tau writes nothing else in a worktree is out of date, because
`.tau/` also holds the folders named above.

## Consequences

### Positive

- A reader knows which copy to trust at each stage.
- A decision survives the end of a session or a worker.
- The user sees every change before it reaches a tracker.

### Negative

- A tool must read the saved copy before it trusts the working copy.
- The approval step adds a pause to each save.

## Alternatives considered

### Write to the tracker directly

Create and edit tickets and pull requests without a working copy. Rejected because the user cannot
review or revise a draft before other people see it.

### Keep the working copy as the source of truth

Treat `.tau/` files as final and push changes to the trackers. Rejected because people edit in the
trackers, and the working copy would drift from what they see.
