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
[ADR 0064 (Deliver worker replies through records)](./README.md#retired),
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
only the worker writes its report and its questions into it.

### Assignment file

- The file holds the task, its acceptance criteria, the loadout, the Pi session, the parent session,
  the questions, and the report. Its format is versioned under
  [ADR 0053](./0053-version-each-saved-record-format.md).
- A launch writes its assignment file and the worker's Pi session file in one folder under Pi's
  agent directory. A follow-up writes a new assignment file in its own folder and points at the
  session file of the earlier assignment. Each Tau checkout has its own folder, so a branch that
  changes the format does not break another checkout.
- The manager never writes the file after launch. The worker is the only writer of `assignment.json`
  after that.
- Each answer is its own immutable file in an `answers` folder beside `assignment.json`, named by
  the question ID. An answer is never written into `assignment.json`, so the manager and the worker
  never write the same file.

### Launch

- A manager counts only its own live children that carry an assignment label, and it refuses a
  launch when that count reaches the capacity. One in-process queue runs the count and the launch in
  turn, so two launches cannot both take the last slot.
- Tau never retries an unclear launch. When `hc` does not confirm a launch, Tau looks up the
  worker's name. If the lookup fails, the slot stays reserved and Tau reports that the launch is
  unclear.
- A failed launch removes its package snapshot. A worker that ends keeps its snapshot and session
  file.
- Every worker gets a herdr pane by its role. An editing worker takes the manager's herdr space and
  tab. Any other worker takes the manager's herdr space and a tab named `<manager tab>-workers`. A
  manager without both labels gives its workers no herdr labels. Tau has no `visibility` parameter.
- A worker's first run starts from a fixed start message that Tau passes on the Pi command line. The
  worker extension replaces it with the task prompt or the restart note, or handles it with no run.
  The worker extension never sends a message during Pi's `session_start`: Pi reports terminal status
  only after every extension has started, so a run that began during startup reported `idle`.

### Report

- The worker finds its assignment path in the label of its own terminal. No environment variable
  carries the path.
- The report tool validates the report and saves it in the assignment file first. Then Tau sets a
  label on the worker's terminal. The manager's `hc` event subscription starts a scan on that label
  change. A failed label keeps the saved report.
- The manager reads its children's assignment files on a child event, at session start, and after
  compaction. It shows each report once for each assignment ID.
- The manager shows reports, questions, and ended messages only for assignments whose parent session
  is its own session file. A new session in the same terminal shows none of these messages for
  earlier sessions' workers, because the record of shown messages lives in each session. A resumed
  session keeps its file and its workers' news. Capacity counting and deadline enforcement still
  cover every child of the terminal.

### Question

- The worker calls `subagent_question` with one question. Tau validates it and saves it in the
  assignment file with a new question ID and the time. Then Tau sets a `tau.question` label on the
  worker's terminal. A failed label keeps the saved question.
- The worker's turn ends after the question is saved. The worker process keeps running and waits for
  an answer.
- The manager shows each question once for each assignment ID and question ID. It reads the
  questions on the same triggers as reports. The shown question carries both IDs, and the manager
  answers with `subagent_answer`.
- `subagent_answer` saves the answer file, then queues one `answer` message to the worker's inbox.
  It never types into the worker's terminal. It refuses before it saves anything when the assignment
  belongs to another manager, the question is not the last one saved, no single live child carries
  the assignment, or the worker has no live inbox lease for its session. The manager reports a
  refusal to the user.
- The worker ends its wait only on a valid answer file for its open question or on a user message.
  Other inbox messages do not end it. A resumed worker whose open question already has a saved
  answer continues from that file.

### Deadline

- The assignment file's `deadline` decides when a worker ends. The `tau.deadline` label is a pointer
  for display only.
- The manager's deadline watchdog arms its timers at session start, after each launch, and on each
  delivery scan. A reload builds a new watchdog. Session shutdown clears every timer.
- Tau warns the worker 90 seconds before its deadline, or at once when less time is left. The
  warning is an `hc send` that asks the worker to call `subagent_report` now. Tau never uses
  `hc send --force`. A refused or failed warning is reported and does not cancel the kill.
- At the deadline, Tau reads the terminal again. It kills the worker only when the terminal is still
  live, its parent is this manager's terminal, its `tau.assignment` label is the same path, and the
  assignment has no saved report.
- Tau fails closed. A missing or malformed assignment file ends the worker at once. Tau never treats
  such a worker as having unlimited time.
- A `tau.deadline` label that is missing, malformed, or different from the assignment is shown as an
  error. The assignment deadline still applies.
- After a successful kill, Tau sets the label `tau.ended=deadline` on the finished worker's
  terminal. A failed kill sets no label and keeps the retry schedule. A failed label after a kill is
  reported once and does not start a retry.
- The launching session shows one "ended at its deadline" message for each assignment ID, even when
  another session in the same terminal performed the kill. The label keeps that fact until the
  launching session reads the worker. A finished worker with no report and this label gets the
  deadline message, not the generic "ended without a report" message. When the label write failed,
  the launching session has no label to read and shows the generic "ended without a report" message
  when another session performed the kill.

### Tools

- The manager has three worker tools. `subagent` launches one, `subagent_follow_up` resumes an ended
  worker from its saved Pi session in a new child with a new assignment file and deadline, and
  `subagent_answer` answers a worker's open question. The manager has no other tool that reads or
  changes a worker.
- The worker has `subagent_report`, `subagent_question`, and the tools of its profile. It has no
  tool to report progress.

## Consequences

### Positive

- The manager and the worker read one record, and the record survives a restart of the manager.
- Worker state comes from `hc`, the same source the user sees with `hc ls`.
- A report reaches the manager without a tool call from the manager. A long report stays in the
  file, not in the message.

### Negative

- Tau refuses to launch outside an `hc` terminal.
- Until later changes add it back on `hc`, a manager cannot cancel a worker, and a worker cannot
  report progress or set a deadline.
- A lost event delays a report until the subscription reconnects or the next session start.
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

### Send the task from the worker's startup

Send the task with `sendUserMessage` while the worker extension starts. Rejected because Pi does not
report that run's status. Fixing Pi's startup order needs an upstream release, and typing the task
into the worker's terminal would make it user input.

### Send the report in the event

Put the full report in the `hc` event payload. Rejected because a report can hold up to 100 evidence
items, and the payload would repeat text that the assignment file already holds.

### Deliver worker news to every session in the terminal

Select workers by parent terminal alone, as capacity does. Rejected because a new session has no
shown messages, so it would show every earlier worker's report and question again.

### One shared record folder

Keep one record folder for every checkout and rely on format versions. Rejected because parallel
branches change the format at the same time and break each other's launches.
