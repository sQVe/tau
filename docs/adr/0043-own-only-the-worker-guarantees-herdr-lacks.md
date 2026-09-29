# ADR 0043: Own only the worker guarantees herdr lacks

- Status: Accepted; placement rule superseded by
  [ADR 0054](./0054-show-one-foreground-worker-per-parent.md); generic workflow rule superseded by
  [ADR 0058](./0058-run-subagents-only-as-pi-workers.md); cleanup rule superseded by
  [ADR 0059](./0059-run-each-pi-worker-as-its-panes-own-process.md)
- Date: 2026-09-24
- Supersedes: [ADR 0029](./0029-version-worker-provider-fingerprints.md),
  [ADR 0031](./0031-reserve-worker-capacity-under-one-tree-lock.md), the claim rules in
  [ADR 0030](./0030-claim-native-follow-ups-before-opening.md) and
  [ADR 0040](./0040-release-undispatched-follow-up-claims-after-cleanup.md), and the settings
  reproduction rule in [ADR 0028](./0028-keep-worker-control-in-the-parent.md)

## Context

The subagents extension grew to most of Tau in about a week. Most of that code enforces guarantees
that herdr does not need Tau for: exact replay of the parent's model settings, nested delegation, a
cross-process capacity lock, successor claims, and capacity held until cleanup is proven. Session
logs show that these guarantees caused most failures and that no observed use needed them:

- Most failed launches were Tau refusing its own preconditions, not crashes. Settings replay refused
  every Pi worker on the user's default provider, though a fresh worker process would load that
  provider normally.
- Most cancellations failed with "No active owned handle", because ownership lived in parent memory
  and was lost on restart.
- Each unconfirmed cleanup kept its capacity slot until the user repaired it by hand.
- No saved task was launched by another worker, and follow-ups never had a claim conflict.

Herdr already launches agents, delivers text, reports live state and session identity, and splits
and closes panes. It cannot say that a task finished, carry a structured question to the parent,
enforce a task deadline, stop an agent, or choose placement. Tau must own those.

## Options considered

- Keep the current guarantees and fix defects as they appear. Rejected: each fix has added states
  and records, and most logged failures are the guarantees themselves.
- Replace Tau's layer with raw herdr agents. Rejected: reviewers started this way do their job, but
  they have no deadline, report, or widget.
- Keep a thin task layer for the gaps herdr leaves, and drop guarantees that no observed use needs.
  Chosen: this keeps the widget and reports while removing most refusal and cleanup paths.

## Decision

Tau owns only what herdr lacks: task records, a completion report, structured questions for Pi
workers, one deadline per task, stopping workers, placement, and the widget. Drop the guarantees
below.

### Worker settings

Start workers with explicit settings: the profile's or requested model as `provider/id`, and the
user's saved Pi configuration. Do not reconstruct or fingerprint the parent's runtime settings. The
worker checks at startup that the model resolves and CC Safety Net is loaded, and refuses otherwise.
Never fall back to another model.

### Nesting and capacity

Workers do not launch workers. They ask the parent instead. Each parent caps its own live workers in
process. Remove the root-tree lock and durable reservations.

### Ownership

Save ownership in the task record. A controller for the same root session may reattach to a live
worker after herdr reports the recorded agent session identity. Sessions in other trees cannot act
on it. Keep one controller per task.

### Placement

Keep serialized, size-aware placement and terminal identity checks. Split the largest eligible pane
with herdr's default ratio, or use a background tab when the pane is zoomed or too small. Herdr owns
layout after placement. Do not rebalance splits or track layout collapse after an owned close.

### Cleanup

Keep the terminal identity check before input or closure. When cleanup cannot be confirmed, show the
worker as needing manual cleanup and keep its references. Do not hold a capacity slot for it.

### Follow-ups

Keep follow-ups. Open the saved session only when no task record holds it and herdr shows no live
agent using it. The single controller serializes these checks, so no claim files are needed.

### Unchanged

Keep the cwd trust boundary. Work in another worktree goes to the agent that owns it, not to a
subagent. Keep the generic workflow for non-Pi harnesses from
[ADR 0033](./0033-use-one-generic-native-worker-workflow.md).

## Tradeoffs

- Most logged launch refusals and all "No active owned handle" failures go away.
- Cancellation and replies survive a parent restart in the same session.
- The widget and report contract stay as they are.
- Cost: a worker no longer inherits runtime-only parent settings, such as a `--model` flag. The
  caller must name them.
- Cost: an unconfirmed worker may keep running outside the cap until the user stops it.
- Cost: a Pi process started by hand on a saved session can still race a follow-up.
- Cost: work that needs delegation from a worker must go through the parent.

## See also

- [ADR 0028: Keep worker control in the parent](./0028-keep-worker-control-in-the-parent.md)
- [ADR 0033: Use one generic native worker workflow](./0033-use-one-generic-native-worker-workflow.md)
- [ADR 0058: Run subagents only as Pi workers](./0058-run-subagents-only-as-pi-workers.md)
