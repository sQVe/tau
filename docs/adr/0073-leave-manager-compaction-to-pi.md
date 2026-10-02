# ADR 0073: Leave manager compaction to Pi

- Status: Accepted
- Date: 2026-09-30
- Supersedes: [ADR 0070](./0070-compact-manager-sessions-at-pi-turn-boundaries.md)
- Extended by: [ADR 0078](./0078-remind-managers-to-compact-and-restore-the-worker-ledger.md)

## Context

- Tau compacted manager sessions by returning a `compaction` draft from `turn_end` and
  `agent_before_settle`. Pi saves such a draft without emitting `session_compact`.
- `pi-claude-bridge` rebuilds its Claude Code session only on `session_compact`. After each Tau
  compaction, a bridge session lost its history, later resumed the session from before the
  compaction, and compacted again and again.
- The owner runs managers through the bridge, so the feature broke the sessions it was meant to
  help.

## Options considered

- Keep the feature until the bridge handles compactions it does not see. Rejected: every bridge
  manager session breaks until then, and other extensions that rely on `session_compact` break the
  same way.
- Call `ctx.compact()` instead of returning a draft. Rejected: it aborts the current run and does
  not resume it.
- Remove Tau's compaction and compact by hand with `/compact`. Chosen: Pi's own path emits
  `session_compact`, so the bridge and other extensions stay consistent.

## Decision

Tau does not compact sessions. Managers and workers use Pi's own compaction, and the user runs
`/compact` when a manager's context grows large. Tau reads no `compaction` key from its config.

## Tradeoffs

- Pi's `session_compact` hooks, compaction UI, and file-list carry-over run on every compaction.
- Cost: a manager pays for a large context until the user compacts or Pi compacts near the window.
- Cost: Pi's summary does not keep a worker ledger, so the manager can lose exact task IDs, question
  IDs, and check evidence. The worker records still hold them, and `subagent_history` reads them.

## See also

- [pi-claude-bridge issue 77](https://github.com/elidickinson/pi-claude-bridge/issues/77#issuecomment-5917778005)
