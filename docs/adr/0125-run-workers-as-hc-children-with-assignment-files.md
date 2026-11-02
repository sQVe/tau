# ADR 0125: Run workers as hc children with one assignment file each

**Date**: 2026-11-02\
**Status**: Accepted\
**Supersedes**: [ADR 0028 (Keep worker control in the parent)](./README.md#retired),
[ADR 0029 (Version worker provider fingerprints)](./README.md#retired),
[ADR 0030 (Claim native follow-ups before opening)](./README.md#retired),
[ADR 0031 (Reserve worker capacity under one tree lock)](./README.md#retired),
[ADR 0032 (Run Claude workers through a parent-owned channel)](./README.md#retired),
[ADR 0033 (Use one generic native worker workflow)](./README.md#retired),
[ADR 0036 (Allowlist worker content and label states from one table)](./README.md#retired),
[ADR 0037 (Launch native workers without parent approval)](./README.md#retired),
[ADR 0040 (Release undispatched follow-up claims after confirmed cleanup)](./README.md#retired),
[ADR 0043 (Run subagents as Pi workers with a thin task layer over herdr)](./README.md#retired),
[ADR 0045 (Keep worker records per Tau checkout and worktree files in `.tau/`)](./README.md#retired),
[ADR 0050 (Split worker control into a coordinator and one controller per worker)](./README.md#retired),
[ADR 0054 (Show one foreground worker per parent)](./README.md#retired),
[ADR 0058 (Run subagents only as Pi workers)](./README.md#retired),
[ADR 0059 (Run each Pi worker as its pane's own process)](./README.md#retired),
[ADR 0097 (Track only the current session's workers)](./README.md#retired),
[ADR 0123 (Delete stopped worker records 14 days after their last write)](./README.md#retired)\
**Related**: [ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md),
[ADR 0067 (Give each worker profile one loadout of tools, skills, instruction sets, and packages)](./0067-give-workers-only-their-profile-tools-and-skills.md),
[ADR 0102 (Require acceptance criteria on editing worker launches)](./0102-require-acceptance-criteria-on-editing-worker-launches.md)

## Context

A manager starts workers, learns when they stop, and reads their reports. Earlier, Tau kept this
state in its own records and in herdr panes. It also gave the manager tools to ask for a worker's
status or cancel it. Those tools repeated facts that the terminal tool already knows.

`hc` runs each terminal with a parent, labels, and a state. A manager can list its live children and
read each one. Tau therefore does not need a second copy of that state.

A worker still needs a record of its task, loadout, and Pi session. The record must survive a
restart of the manager, and the manager and the worker must read the same record. A report can be
long, so the message that announces it must stay short.

## Decision

Tau starts each worker as a child terminal of its manager's `hc` terminal. Each launch writes one
versioned assignment file before the worker starts. The manager and the worker read that file, and
only the worker writes its report into it.

### Assignment file

- The file holds the task, its acceptance criteria, the loadout, the Pi session, the parent session,
  and the report. Its format is versioned under
  [ADR 0053](./0053-version-each-saved-record-format.md).
- The file and the worker's Pi session file sit in one folder under Pi's agent directory. Each Tau
  checkout has its own folder, so a branch that changes the format does not break another checkout.
- The manager never writes the file after launch.

### Launch

- A manager counts only its own live children that carry an assignment label, and it refuses a
  launch when that count reaches the capacity. One in-process queue runs the count and the launch in
  turn, so two launches cannot both take the last slot.
- Tau never retries an unclear launch. When `hc` does not confirm a launch, Tau looks up the
  worker's name. If the lookup fails, the slot stays reserved and Tau reports that the launch is
  unclear.
- A failed launch removes its package snapshot. A worker that ends keeps its snapshot and session
  file.
- A foreground worker takes the manager's herdr space and tab. A background worker gets no pane.

### Report

- The worker finds its assignment path in the label of its own terminal. No environment variable
  carries the path.
- The report tool validates the report and saves it in the assignment file first. Then Tau sets a
  label on the worker's terminal and sends the manager a short note with the file path. A failed
  label or note keeps the saved report.
- The manager reads its children's assignment files when a note arrives, at session start, and after
  compaction. It shows each report once for each assignment ID.

### Tools

- The manager has no tool that reads or changes a worker after launch. Its only worker tool is
  `subagent`, which launches one.
- The worker has `subagent_report` and the tools of its profile. It has no tool to ask a question or
  report progress.

## Consequences

### Positive

- The manager and the worker read one record, and the record survives a restart of the manager.
- Worker state comes from `hc`, the same source the user sees with `hc ls`.
- A report reaches the manager without a tool call from the manager. A long report stays in the
  file, not in the message.

### Negative

- Tau refuses to launch outside an `hc` terminal.
- Until later changes add them back on `hc`, a manager cannot follow up, reply to, or cancel a
  worker, and a worker cannot ask a question or set a deadline.
- A lost note delays a report until the next session start or compaction.
- After an unclear launch, a person must check `hc ls` by hand.
- Tau keeps every assignment folder. No rule deletes them yet.
- Tau does not read task records from earlier formats, so their workers cannot be reported or
  controlled through Tau.

## Alternatives considered

### Keep the herdr controller and its tools

Keep the controller, the status and cancel tools, and Tau's own worker records beside `hc`. Rejected
because it keeps a second worker state, and each tool repeats a fact that `hc` reports.

### Keep status and cancel as `hc` wrappers

Keep both tools and read `hc` inside them. Rejected because the manager already reads its children
through `hc` for capacity and reports. A tool would add a second contract over the same reads and no
new fact.

### Send the report in the note

Put the full report in the `hc` note. Rejected because a report can hold up to 100 evidence items,
and the note would repeat text that the assignment file already holds.

### One shared record folder

Keep one record folder for every checkout and rely on format versions. Rejected because parallel
branches change the format at the same time and break each other's launches.
