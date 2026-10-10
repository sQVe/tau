# ADR 0100: Let agents cancel Linear tickets after approval

**Date**: 2026-10-10\
**Status**: Accepted\
**Supersedes**: the status rule of
[ADR 0082 (Own Linear conventions in one tracker skill)](./0082-own-linear-conventions-in-one-tracker-skill.md)

## Context

Agents could start slices but could not cancel tickets. Duplicates and slices dropped from a plan
needed a manual step in Linear, although every Linear write already waits for an approved preview.

## Decision

Agents may cancel a Linear ticket after the user approves a preview that shows the cancellation.
They use the team's state whose type is `canceled`, since teams name it differently. They never
cancel a completed ticket or a ticket whose pull request merged.

Starting a slice still moves it to In Progress without extra approval. Linear's GitHub integration
still moves a ticket to Done when its pull request merges. Agents never close, reopen, or make any
other status change.

## Consequences

### Positive

- The user approves a cancellation in the preview instead of doing it in Linear.

### Negative

- A wrong approval cancels a ticket the user meant to keep. The user must reopen it in Linear, since
  agents never reopen tickets.

## Alternatives considered

### Keep cancellation manual

The agent lists tickets to cancel, and the user cancels them in Linear. Rejected because the preview
already gives the user control, so the manual step adds work without adding safety.

### Let agents make any status change after approval

Allow close, reopen, and other moves behind the same preview. Rejected because Done belongs to the
merged PR, and no workflow has needed other moves.
