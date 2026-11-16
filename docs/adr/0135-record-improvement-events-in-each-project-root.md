# ADR 0135: Record improvement events in each project root

**Date**: 2026-11-15\
**Status**: Accepted\
**Related**: [ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md)

## Context

Tau saves review findings, fix rounds, and worker reports per task, but nothing notices that the
same mistake happened in several tasks. A loop that finds repeated mistakes needs weeks of saved
facts, so recording has to start before the review steps exist.

Work on one project runs in many worktrees that come and go. A record kept in a worktree is lost
when the worktree is removed, and a record kept per worktree splits one project's history.

Skill, check, and rule changes affect every later agent. The user does not want automation that runs
or changes things where they cannot see it.

## Decision

Tau saves each improvement fact as one versioned JSON event file in the project root's
`.tau/improvement/`, starts no background work, and changes nothing without the user's approval.

### Events

- The project root is the parent of the Git common directory. Every linked worktree and the bare
  root of a project resolve to the same directory, so all of them write one shared history that
  outlives each worktree.
- Each event is its own file, named by its ID, and is never replaced. A second write of the same ID
  keeps the first file. A retried tool call then saves no duplicate, and concurrent sessions need no
  lock across files.
- A reader skips an event with a newer format and returns it with its path and a notice to restart
  the session, as [ADR 0053](./0053-version-each-saved-record-format.md) says.
- A damaged event is an exception to [ADR 0053](./0053-version-each-saved-record-format.md). An
  event that is not JSON, or that claims a known version and fails its schema, stops the read with
  an error naming its path. A skipped damaged event would silently change the counts the loop relies
  on.
- A user correction is saved when it happens. The manager fixes the mistake, saves a `correction`
  event with the `improvement` tool, and proposes a rule or check. Later reviews count repeated
  corrections from these events.

### Task facts and signals

- The loop reads each merged task's facts from the tool calls in its Pi transcripts, without a
  model. The `pr` tool call that verified a pull request ties the transcript to that task. When no
  transcript publishes the pull request, the transcript in the folder named by the branch's ticket
  ID stands in for it.
- A tool call whose shape or result the reader does not know is missing evidence. The counts it
  affects read unknown, not zero. Each task also reports whether its manager and worker transcripts
  were found.
- Review signals are pure rules over those counts, with thresholds set on past merged tasks. A count
  at its threshold fires even when some of its facts are missing. A count below its threshold with
  missing facts, or on a task without transcript coverage, reads unknown. The revert signal comes
  from merged pull requests and default-branch commits, not transcripts.

### No background timer

Recording and review start only inside a Pi session the user runs, or from the user's command.
Nothing runs on a schedule outside Pi.

### Approval

Automatic steps only propose. The user approves each change before Tau edits a skill, check, rule,
or ticket.

## Consequences

### Positive

- One project keeps one history across all its worktrees.
- Saving a correction is safe to retry.
- The user sees and approves every change the loop makes.
- Each task fact names the transcript entry it comes from, so a signal can be checked by hand.

### Negative

- Days without a Pi session record nothing until the next session catches up.
- A history that spans projects must read each project root.
- A mistake that leaves no tool call behind, such as a skipped test-first step, raises no signal.

## Alternatives considered

### A central log file

Keep all events of all projects in one file in the agent directory. Rejected because concurrent
sessions would append to one file, and a project's history would live apart from the project.

### Classify transcripts with a model

Ask a model whether each task went wrong. Rejected because its answer changes between runs and names
no tool call it rests on, while counts from tool calls can be checked against the transcript.

### A systemd timer

Run the sweep and open a review tab from a systemd user timer, so it works while Pi is closed.
Rejected because the user does not want invisible background automation.
