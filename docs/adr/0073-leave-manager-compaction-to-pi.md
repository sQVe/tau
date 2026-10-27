# ADR 0073: Leave manager compaction to Pi

**Date**: 2026-09-30\
**Status**: Accepted\
**Supersedes**: [ADR 0070 (Compact manager sessions at Pi turn boundaries)](./README.md#retired),
[ADR 0078 (Remind managers to compact and restore the worker ledger after each compaction)](./README.md#retired),
[ADR 0114 (Remind managers at half the context window to start a new session)](./README.md#retired)\
**Related**: [pi-claude-bridge issue 77](https://github.com/elidickinson/pi-claude-bridge/issues/77#issuecomment-5917778005)

## Context

Pi compacts a session only near the model's context window. A manager session can grow large long
before that.

Pi's summary drops exact task IDs and question IDs, and a manager needs them to reply to a worker or
read its report.

Pi saves a compaction that does not go through its own path without emitting `session_compact`.
`pi-claude-bridge` rebuilds its Claude Code session only on that event. A compaction that Tau wrote
therefore left bridge sessions resuming from before the compaction, and they compacted again.

## Decision

Tau never starts a compaction. Pi and the user own compaction, and Tau only reminds the user to
start a new session. Workers keep Pi's defaults.

### Reminder

- Once the context passes 50% of the model's context window, Tau shows one warning. The warning says
  to finish the current ticket, then start a new session. The threshold has no config key.
- The reminder sends the model nothing and blocks nothing.
- Tau shows the reminder again only after a compaction or after the context is at or below 50%. A
  new session also clears it. A missing usage reading keeps the current state.

### Worker ledger

- After each compaction, Tau queues a hidden message for the next prompt. It starts no turn.
- The message lists the current session's workers that have not stopped or have a pending question.
  Unresolved workers are included. Each line gives the task ID, name, state, and pending question
  ID.
- The message ends by pointing to `subagent_status` for worker reports.
- Tau sends nothing when no worker is listed.

### Worker notices

- While Pi is idle, a notice wakes the manager.
- While a run is active, including Pi's automatic compaction, Tau steers the notice into the run.
- While Pi is busy without a run, as in a manual `/compact`, Tau queues the notice for the next
  prompt. The notice does not wake Pi.

## Consequences

### Positive

- Pi's `session_compact` hooks, compaction UI, and file-list carry-over run on every compaction.
- Tau never starts a compaction, so no compaction of Tau's interrupts work in progress.
- The worker ledger reaches the model after every compaction, whoever wrote the summary.

### Negative

- A manager pays for a large context until the user starts a new session, compacts, or Pi compacts
  near the window.
- Pi's summary lacks exact IDs. The ledger restores the open workers as a separate message. Finished
  workers and their reports need a `subagent_status` call.
- A notice that arrives during a manual compaction does not wake the manager. The user started the
  compaction and sends the next prompt.
- 50% is a guess. No measurement shows where a manager's work starts to degrade.
- A user who prefers `/compact` gets advice that does not match that habit.

## Alternatives considered

### Compact from Tau's turn boundaries

Return a compaction draft from `turn_end` and `agent_before_settle` once the context passes a
threshold. Rejected because Pi saves such a draft without emitting `session_compact`. The bridge
then resumes sessions from before each compaction, and other extensions that rely on that event
break the same way.

### Call `ctx.compact()`

Call `ctx.compact()` instead of leaving compaction to Pi. Rejected because it aborts the current run
and does not resume it.

### Hold notices until Pi is idle

Hold notices while Pi is busy without a run, and release them once Pi is idle. Rejected because Pi
exposes no state for a user prompt that has passed its `input` event but has not started its run. A
release in that window starts a second prompt, and Pi rejects one of the two.

### Block work past the threshold

Refuse tool calls or prompts once the context passes the threshold. Rejected because the threshold
is a guess, and a block would stop work in progress at a false alarm.

### Config key for the threshold

Let the user set the percentage in Tau config. Deferred because no user has asked for another value,
and the key would need validation and documentation.

### Hand off to a new session

Hand off to a new session with a written brief, as Amp does. Rejected because the manager loses its
session, its worker ownership, and the user's place in the conversation.
