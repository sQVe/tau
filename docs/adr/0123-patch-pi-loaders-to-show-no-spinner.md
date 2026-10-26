# ADR 0123: Patch Pi loaders to show no spinner

**Date**: 2026-10-26\
**Status**: Accepted

## Context

Pi's `Loader` component animates a spinner and requests a render on every frame. Pi lays out the
whole transcript again for each render, so a session that waits on a tool spends a large share of a
core on spinner frames, and the cost grows with the transcript. A session that waits on `!sleep 60`
used 11 to 31% of a core, while an idle session used about 1%.

Pi offers `ctx.ui.setWorkingIndicator` for the agent's working indicator. It does not reach other
loaders, such as the one that shows a running bash command. Pi offers no setting that turns off or
slows the animation of every loader.

## Decision

Tau replaces `Loader.prototype.restartAnimation` from `@earendil-works/pi-tui` so it stops any
running animation and schedules none. It also replaces `Loader.prototype.getRenderedIndicator` so it
returns an empty string, because a spinner that does not spin looks stalled. Each loader keeps its
message, so a waiting session still shows that it works. The patch applies to every loader in the
process, including loaders that Pi creates, because Pi's compiled binary resolves the import to its
own copy of the package.

Drop the patch when Pi offers a static or slower indicator for all loaders, or stops laying out the
whole transcript for a spinner frame.

## Consequences

### Positive

- A session that waits on a tool uses close to its idle CPU.
- The fix covers loaders that extension APIs cannot reach.

### Negative

- Tau changes two private methods of a Pi class. A Pi release that renames or reworks it can break
  the patch without a type error.
- No loader animates, so a stalled session and a working one look alike until the message changes.
- When Pi embeds the working status in a narrow editor border, it falls back to the spinner alone,
  which is now empty.

## Alternatives considered

### Set a static working indicator

Call `ctx.ui.setWorkingIndicator` with no frames. Rejected because it does not reach the bash
execution loader or other loaders, which keep animating.

### Keep the first spinner frame

Stop the animation but keep its first frame. Rejected because a spinner that never moves suggests a
stalled session.

### Wait for an upstream fix

Ask Pi to keep transcript layout across frames or to slow the spinner, and change nothing in Tau.
Deferred because the waiting cost stays until Pi ships a fix. The request is drafted for Pi, and
this patch goes away when Pi ships one.
