# ADR 0043: Own only the worker guarantees herdr lacks

- Status: Accepted
- Date: 2026-09-24
- Supersedes: [ADR 0029](./0029-version-worker-provider-fingerprints.md),
  [ADR 0031](./0031-reserve-worker-capacity-under-one-tree-lock.md), the claim rules in
  [ADR 0030](./0030-claim-native-follow-ups-before-opening.md) and
  [ADR 0040](./0040-release-undispatched-follow-up-claims-after-cleanup.md), and the settings
  reproduction rule in [ADR 0028](./0028-keep-worker-control-in-the-parent.md)

## Context

The subagents extension grew to 11.6k source lines in eight days, 68% of Tau. Most of that code
enforces guarantees that herdr does not need Tau for: exact replay of the parent's model settings,
nested delegation, a cross-process capacity lock, successor claims, and capacity held until cleanup
is proven. Fixes land in that code. PR #81 alone added 1,374 lines of startup and cleanup handling.

Session logs since 2026-09-15 show where the cost falls:

- 21 of 77 launches failed. 19 were Tau refusing its own preconditions, not crashes.
- 5 of 8 cancellations failed with "No active owned handle", because ownership lives in parent
  memory and is lost on restart.
- Cleanup ended unconfirmed 15 times against 33 confirmed stops. Each unconfirmed worker kept its
  capacity slot until the user repaired it by hand.
- Settings replay refuses valid launches. It reloads the parent's extensions inside the parent
  process. pi-claude-bridge registers its provider only on the first load per process, so the reload
  finds no `claude-bridge` models. Every Pi worker on the user's default provider fails with "Worker
  cannot reproduce the parent model configuration", though a fresh worker process would register the
  provider normally.
- No saved task out of 87 was launched by another worker.
- Follow-ups ran 32 times. No claim conflict ever occurred.

Herdr 0.9.1 already launches agents, delivers text, reports live state and session identity, and
splits and closes panes. It cannot say that a task finished, carry a structured question to the
parent, enforce a task deadline, stop an agent, or choose placement. Tau must own those.

## Options considered

- Keep the current guarantees and fix defects as they appear. Each fix has added states and records,
  and most logged failures are the guarantees themselves.
- Replace Tau's layer with raw herdr agents. Reviewers started this way do their job, but they have
  no deadline, report, or widget.
- Keep a thin task layer for the gaps herdr leaves, and drop guarantees that no observed use needs.
  This keeps the widget and reports while removing most refusal and cleanup paths.

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
