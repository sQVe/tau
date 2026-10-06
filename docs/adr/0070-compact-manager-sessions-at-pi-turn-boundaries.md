# ADR 0070: Compact manager sessions at Pi turn boundaries

**Date**: 2026-09-29\
**Status**: Superseded\
**Superseded by**:
[ADR 0073 (Leave manager compaction to Pi)](./0073-leave-manager-compaction-to-pi.md)\
**Related**: [ADR 0061 (Layer Tau config from user and repository files)](./0061-layer-tau-config-from-user-and-repository-files.md),
[ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md)

## Context

A manager session runs long. Pi compacts only near the context window, so a manager pays for a large
context on every request long before that. Pi's `compaction` settings apply to every session in the
agent directory, workers included.

Pi's default summary keeps only the first 2,000 characters of each tool result, and its prompt asks
for no IDs, hashes, or check evidence. A manager needs exact task IDs, question IDs, diff hashes,
and check log paths to continue.

Since Pi 0.87, `turn_end` and `agent_before_settle` handlers can return a `compaction` entry draft.
Pi saves it before the next model request, and the run continues without an abort. Tau already saves
each worker's task, state, questions, and report evidence in its own records.

## Decision

Tau compacts manager sessions itself. At `turn_end`, and at `agent_before_settle` when a run ends,
it returns a `compaction` draft once the context passes a threshold. It never calls `ctx.compact()`
and never changes Pi's settings. Returning the draft from the turn boundary in a manager-only
extension keeps the run going, leaves workers on Pi's defaults, and lets Tau write the summary.

### Scope and trigger

- Only a manager registers the handlers. A worker process keeps Pi's own compaction.
- The threshold comes from `compaction.thresholdTokens` in Tau config, 200,000 tokens by default.
  The repository file overrides the user file. It must be at least 40,000 tokens, twice the kept
  tail, so that one compaction does not fill the context back up to the threshold.
- Tau skips a turn that did not complete, a run the user aborted, and a boundary that already holds
  a compaction draft.
- The kept part holds about the last 20,000 tokens and starts at a user or assistant entry, never at
  a tool result.

### Summary

- A worker ledger leads the summary. Tau builds it from its saved worker records for the session
  tree, not from the model. The draft's `details` holds the same ledger with a format version.
- A model summary follows. It uses the session's model and a prompt that asks for scope, user
  authorization, worktrees and baselines, exact identifiers, check evidence, and open findings. It
  summarizes the previous summary together with the newer messages.

### Failure

- A failure or a shutdown during the summary returns no draft, and so does a user abort at
  `turn_end`. The session keeps its full context, and Pi's own compaction still applies near the
  window.
- After a failed summary, Tau waits until the context has grown by the kept tail before it tries
  again. A successful compaction or a new session ends the wait.
- Tau shows its own status line while it writes the summary, because this path shows no Pi
  compaction state.

## Consequences

### Positive

- Worker IDs and evidence survive every compaction, because the model does not write them.
- The run continues after compaction, and queued input keeps its order.

### Negative

- Tau owns the cut point and the summary request, because Pi does not export its own preparation.
- The run waits while the summary is written, and each compaction drops the prompt cache once.
- Pi's `session_compact` hooks, compaction UI, and file-list carry-over do not run on this path.
- At `agent_before_settle` the run has already ended, so Pi gives the handler no abort signal. A
  user abort there waits for the summary, and Pi saves the draft anyway.
- The boundary API is new, and Pi still has open issues about aborts between turns.

## Alternatives considered

### Lower Pi's compaction threshold

Lower the threshold in Pi's `compaction` settings. Rejected because the settings reach workers too,
and the summary stays Pi's default.

### Call `ctx.compact()`

Call `ctx.compact()` when the threshold passes. Rejected because it aborts the current run and does
not resume it.

### Filter old messages

Filter old messages in the `context` event. Rejected because it saves no state, so every request
repeats the work, and each change drops the prompt cache.

### Hand off to a new session

Hand off to a new session with a written brief, as Amp does. Rejected because the manager loses its
session, its worker ownership, and the user's place in the conversation.
