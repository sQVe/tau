# ADR 0058: Run subagents only as Pi workers

- Status: Accepted
- Date: 2026-09-28
- Supersedes: [ADR 0032](./0032-run-claude-workers-through-a-parent-owned-channel.md),
  [ADR 0033](./0033-use-one-generic-native-worker-workflow.md),
  [ADR 0037](./0037-launch-native-workers-without-parent-approval.md), the generic workflow rule in
  [ADR 0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md), the generic steps in
  [ADR 0050](./0050-split-worker-control-into-a-coordinator-and-one-controller-per-worker.md), and
  the non-Pi report area in
  [ADR 0045](./0045-keep-worker-records-per-checkout-and-worktree-files-in-tau.md)

## Context

- Tau-owned subagents had two lifecycles: Pi workers with structured controls, and a generic herdr
  workflow for every other kind (ADR 0033). Every lifecycle change had to carry both. The controller
  split (ADR 0050) and the pure decision modules both did.
- The generic path added about 780 production lines and 1,600 test lines, plus Pi and non-Pi
  branches in about 15 more files.
- Its parameters filled the tool descriptions that every parent session loads. The Pi and non-Pi
  reply rules confused agents (ME-447).
- Of 343 worker runs in the 30 days before 2026-09-28, 323 were Pi. The 20 non-Pi runs (19 Claude, 1
  Codex) all ran on 2026-09-22 and 2026-09-23 and match the proof runs for the generic workflow.
- Pi already runs Claude and GPT models through its providers, so a Pi worker covers model variety.
- The vision says to hand off to the tool that already does the job, such as a browser task to
  Claude Code. The handoff skill does this with `herdr agent prompt` to the agent in another
  workspace. That agent owns its workspace, and Tau does not own its lifecycle.

## Options considered

- Keep the generic workflow. It serves no regular use and keeps doubling every lifecycle change.
- Move non-Pi workers into a separate tool. Tool descriptions get shorter, but the controller still
  carries both lifecycles.
- Run subagents only as Pi workers, and send work for Claude Code or Codex through a handoff to a
  workspace. Choose this option.

## Decision

Tau-owned subagents run only as Pi workers. Claude and GPT models still run as Pi workers through
Pi's providers. A task for Claude Code, Codex, or another agent goes to that agent's workspace
through a handoff. The handoff is not a subagent.

### Tool surface

The launch tool has no harness, native argument, or permission parameter. Every worker uses the
trusted full-tool permission, so the parameter chose nothing. Replies always need the `questionId`
from a worker question. Status has no native submission or terminal output reads.

### Profiles

A profile without `cli:`, or with `cli: pi`, is a Pi profile. Any other `cli:` value fails with a
message that says non-Pi workers are no longer supported.

### Saved records

Task record format 3 keeps its version, because the saved fields of Pi tasks do not change. An older
Tau still reads the Pi tasks this Tau writes.

Generic task records are retired under [ADR 0053](./0053-version-each-saved-record-format.md), at
version 2 and at version 3. A scan skips them with a notice that non-Pi workers are no longer
supported. A direct read, such as status or a follow-up of that task, fails with the same message.
Neither case stops work on other tasks. Tau does not read the submission records, native references,
or report files in those task folders.

Following [ADR 0052](./0052-drop-backwards-compatibility-by-default.md), no other generic path
stays.

## Tradeoffs

- One worker lifecycle, one reply rule, and shorter tool descriptions in every parent session.
- Future lifecycle changes and pure modules no longer carry a second harness.
- Cost: a subagent cannot run the Claude Code or Codex harness itself, with its own tools and
  integrations. That work goes to a workspace, where Tau has no deadline, report, or widget.
- Cost: saved generic tasks can no longer be read, reattached, or cancelled through Tau. Their panes
  and report files stay until the user removes them.
- Cost: a profile that sets another `cli:` stops working until the user removes the setting.

## See also

- [ADR 0052: Drop backwards compatibility by default](./0052-drop-backwards-compatibility-by-default.md)
- [ADR 0053: Version each saved record format](./0053-version-each-saved-record-format.md)
- [Vision](../vision.md)
