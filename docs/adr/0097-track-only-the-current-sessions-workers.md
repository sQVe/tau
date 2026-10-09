# ADR 0097: Track only the current session's workers

**Date**: 2026-10-09\
**Status**: Accepted\
**Supersedes**: the worker history scope in
[ADR 0045 (Keep worker records per Tau checkout and worktree files in `.tau/`)](./0045-keep-worker-records-per-checkout-and-worktree-files-in-tau.md),
the history recovery guidance in
[ADR 0073 (Leave manager compaction to Pi)](./0073-leave-manager-compaction-to-pi.md), the history
tool references in
[ADR 0078 (Remind managers to compact and restore the worker ledger after each compaction)](./0078-remind-managers-to-compact-and-restore-the-worker-ledger.md)
and [ADR 0087 (Gather evidence with codemode)](./0087-gather-evidence-with-codemode.md), and the
task record retirement policy in
[ADR 0058 (Run subagents only as Pi workers)](./0058-run-subagents-only-as-pi-workers.md)\
**Related**: [ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md)

## Context

A manager needs to track the workers it launched, including their reports after they stop. Searching
workers across resumed and forked session trees requires ancestry checks and continuation history.
It also makes follow-up authority broader than the session that launched the worker.

Reading older task formats requires schemas and upgrade rules that do not help a manager control its
current workers. Saved records still need to survive restarts of the same session.

## Decision

Tau tracks only workers launched by the current parent session, live or stopped. The parent session
ID is the authority for status, replies, cancellation, and follow-ups. A fork does not inherit that
authority. Restarting the same session keeps it and may reattach live workers.

Remove `subagent_history` and the `/subagents` history overlay. Keep the passive worker widget and
`subagent_status`. Managers use their launch results and worker notices to retain task IDs. After
compaction, the worker list points only to `subagent_status` for reports.

Read only the current task record format. Older versions are retired and skipped without blocking
other tasks. Do not upgrade, rewrite, or delete them. This keeps the reader's policy independent of
old worker kinds and loadout shapes. The current worker ownership record format is unchanged.

## Consequences

### Positive

- Every worker control uses the same parent-session boundary.
- Worker tracking no longer needs a cross-session history reader or an interactive history view.
- Task readers do not carry older schemas and upgrade rules.

### Negative

- A manager cannot find or follow up workers from another session, including a related fork.
- A manager that loses a stopped worker's task ID must recover it from its session evidence.
- Tasks saved in older formats cannot be reattached or controlled through Tau. Their files remain on
  disk, and any live panes need manual inspection.

## Alternatives considered

### Keep cross-session history and follow-ups

Keep ancestry-based history searches and authorize follow-ups across a session tree. Rejected
because managers need their own workers, while broader authority requires extra ancestry and
continuation validation.

### Keep older task format upgrades

Continue converting older saved tasks into the current format. Rejected because each format adds
schemas and conversion rules that the current-session workflow does not need.

### Track only live workers

Drop workers as soon as they stop. Rejected because the parent still needs their reports and may
send a follow-up within the same session.
