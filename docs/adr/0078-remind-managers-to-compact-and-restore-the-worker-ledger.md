# ADR 0078: Remind managers to compact and restore the worker ledger after each compaction

- Status: Accepted
- Date: 2026-10-01
- Extends: [ADR 0073](./0073-leave-manager-compaction-to-pi.md)

## Context

- ADR 0073 left compaction to Pi and the user. `pi-claude-bridge` registers a 1,000,000-token window
  for its `[1m]` models, so Pi's own compaction almost never runs for a bridge manager. The user
  needs a prompt to run `/compact`.
- Pi's summary drops exact task IDs, question IDs, and check evidence. Tau's worker records still
  hold them.
- A worker notice that arrives during a manual compaction uses `triggerTurn`. Pi is busy but not
  running a turn, so the notice starts a turn beside the summary. That turn also skips
  `before_agent_start`, which the bridge needs.
- Pi runs `session_before_compact` handlers one at a time in load order. When the bridge loads
  first, Tau's handler runs only after the bridge has written the summary.

## Options considered

- Start compaction from `agent_settled` with `ctx.compact()`. Rejected after a spike: Pi emits
  `agent_settled` after a user abort too, and `ctx.compact()` aborts any run that started meanwhile
  and does not resume it. The resume message and the ledger in the summary also depend on bridge
  internals that Tau does not pin.
- Add the ledger to the summary by changing `customInstructions` in `session_before_compact`.
  Rejected: it works only when Tau's handler runs before the bridge's, which depends on the user's
  and the repository's package order. Pi's own summary ignores the change, and Pi drops the
  instructions when nothing precedes the current turn.
- Keep ADR 0073 unchanged. Rejected: bridge managers grow without bound, and worker notices still
  race the summary.
- Hold notices while Pi is busy without a run, and release them once Pi is idle. Rejected: Pi
  exposes no state for a user prompt that has passed its `input` event but has not started its run.
  A release in that window starts a second prompt, and Pi rejects one of the two.
- Remind the user, restore the ledger as a message after `session_compact`, and queue notices for
  the next prompt while Pi is busy without a run. Chosen: Pi and the user keep compaction, each part
  works with any summary writer and any load order, and no notice races a user prompt.

## Decision

Tau still never starts a compaction. In manager sessions it adds three things around Pi's
compaction. Workers keep Pi's defaults.

### Reminder

- Once the context passes `compaction.reminderTokens` from Tau config, Tau shows one notice that
  suggests `/compact`. The default is 200,000 tokens. The repository file overrides the user file,
  and an invalid value fails at session start.
- The reminder shows again only after a compaction or after the context drops below the threshold.
  It sends the model nothing.

### Worker ledger

- After every `session_compact`, Tau reads its saved worker records and queues the ledger as a
  `nextTurn` message. The model sees it with the next prompt, and no turn starts for it.

### Worker notices

- While Pi is busy and no run is active, as in a manual `/compact`, Tau sends each notice as a
  `nextTurn` message without `triggerTurn`. It reaches the model with the next prompt, whether the
  user's or one a later notice starts.
- Pi's automatic compaction runs inside a run, so Tau steers notices into it. Pi queues them and
  sends no request until the compaction ends.
- An idle manager still wakes for a notice, and a running one still gets it as a steer.

## Tradeoffs

- The user decides when to compact, so no compaction aborts work in progress.
- The ledger reaches the model after every compaction, whoever wrote the summary.
- Cost: a manager that ignores the reminder keeps paying for a large context.
- Cost: the summary itself still lacks exact IDs. The ledger arrives as a separate message.
- Cost: a notice that arrives during a manual `/compact` does not wake the manager by itself. The
  user started the compaction and is present to send the next prompt.

## See also

- [ADR 0061: Layer Tau config from user and repository files](./0061-layer-tau-config-from-user-and-repository-files.md)
- [ADR 0070: Compact manager sessions at Pi turn boundaries](./0070-compact-manager-sessions-at-pi-turn-boundaries.md)
