# ADR 0101: Treat `.tau/` files as the working copy and trackers as the saved copy

**Date**: 2026-10-10\
**Status**: Accepted\
**Related**: [ADR 0043 (Run subagents as Pi workers with a thin task layer over herdr)](./0043-own-only-the-worker-guarantees-herdr-lacks.md),
[ADR 0108 (Make Linear writes on the user's own work without asking)](./0108-make-linear-writes-on-the-users-own-work-without-asking.md)

## Context

Tau now keeps drafts of tickets, slices, pull requests, and review feedback in `.tau/` folders such
as `slices/`, `pr/`, and `pr-feedback/`. Linear and GitHub hold the same items after they are saved.
Two copies of one item can disagree, and nothing says which one a reader should trust.

Run state, such as a worker's session or a handover message, is short lived. A decision that exists
only there is lost when the session ends. Earlier, Tau wrote nothing else in a worktree, which no
longer matches these folders.

## Decision

Files in `.tau/` are the working copy, and Linear and GitHub hold the saved copy.

Which writes need an approved preview is set by
[ADR 0108](./0108-make-linear-writes-on-the-users-own-work-without-asking.md) and the
[tracker skill's hard rules](../../src/skills/tracker/SKILL.md#hard-rules). A write that needs
approval waits for an approved preview of what it will save. A tool reads the saved copy before it
plans a write. Once a saved copy exists, it wins over a working copy the user has not approved. An
approved preview may change it, and the preview names each field it changes, so edits made in the
tracker are never lost unseen.

Run state is never the only copy of a decision. A decision goes into a working copy or a tracker. A
handover links to working copies or tickets and is not a record itself.

Handover messages go in `.tau/handovers`, which the handover tool prepares. A handover is one-way
and gets no reply. Replies once went to the sender's pane, and when that pane had closed, the
receiver guessed another pane in the workspace. One reply reached an unrelated session and took the
place of its user's message. Most handovers need no reply.

Each worktree keeps its files in a `.tau/` folder at the checkout root. Before Tau writes there, it
makes sure `.tau/.gitignore` ends with a `*` line, so Git ignores the folder without edits to the
repository's `.gitignore`, `.git/info/exclude`, or the user's global excludes. Tau refuses a `.tau/`
path that is a symbolic link, so a write never leaves the worktree.

## Consequences

### Positive

- A reader knows which copy to trust at each stage.
- A decision survives the end of a session or a worker.
- The user sees each write that needs approval before it reaches a tracker.

### Negative

- A tool must read the saved copy before it trusts the working copy.
- Each write that needs approval adds a pause.

## Alternatives considered

### Write to the tracker directly

Create and edit tickets and pull requests without a working copy. Rejected because the user cannot
review or revise a draft before other people see it.

### Keep the working copy as the source of truth

Treat `.tau/` files as final and push changes to the trackers. Rejected because people edit in the
trackers, and the working copy would drift from what they see.
