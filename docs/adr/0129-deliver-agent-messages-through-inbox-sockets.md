# ADR 0129: Deliver agent messages through each session's inbox socket

**Date**: 2026-11-06\
**Status**: Accepted\
**Supersedes**: [ADR 0126 (Deliver worker news through `hc` events, not typed pane input)](./README.md#retired)\
**Related**:
[ADR 0125 (Run workers as hc children with one assignment file each)](./0125-run-workers-as-hc-children-with-assignment-files.md),
[ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md)

## Context

Tau agents sent handovers, worker answers, and notes with `hc send`. It pastes text into another
terminal and presses Enter. An unrequested note once joined a user's half-typed prompt, and the pane
submitted both as one instruction. Typed text cannot tell the receiver who sent it, and the sender
cannot tell whether the receiver accepted it.

Worker news already avoids typing: a worker sets a label, and the manager reads `hc` events. Other
messages need the same property, plus a reply that says whether the receiver saved the message.

## Decision

Every message from one Tau session to another goes through the receiver's inbox socket, and no Tau
session types into another agent's terminal. The receiver decides what to save, saves it in its own
folder, and replies before the sender reports success.

### Inbox socket

- Every Tau session's inbox binds one pathname Unix socket in a folder only the user can read. It
  advertises the socket path in one `tau.inbox` label on its own terminal.
- A reload keeps one listener. Shutdown closes the socket and removes the label. A stale socket is
  replaced only when a connect to it is refused, so a live owner is never replaced.

### Sending

- A send opens one connection, writes one message, and reads one `queued` or `refused` reply.
- A sender refuses a missing label, an unknown protocol, and a refused connection before it writes
  anything.
- When the reply is missing after the message was written, the result is `unknown`, because the
  receiver may have saved it. A retry reuses the message ID, so the receiver saves it once.

### Receiving

- The receiver checks each message for its family, then saves the record in its own folder and
  replies `queued`. Only the receiver deletes a record.
- After a best-effort startup gate, the receiver wakes its session with the message, saves a receipt
  in the session, and then deletes the record. A receipt stops a repeated delivery after a reload.
- Delivery is at least once. A crash after the message is shown but before Pi saves the session can
  show the message again on the next start.
- Pi can drop a queued message before its receipt, as Escape does. Pi exposes no read of its queue
  when a run settles. A run that settles without an abort has emptied the queue, so Tau shows each
  queued message without a receipt again. After an aborted settle, Tau does so only in Pi's terminal
  UI, which clears its queue before every abort. Outside the terminal UI, a message Pi dropped on an
  abort is recovered at the next settle without an abort.
- Tau steers a newly arriving message into a running session only while the run's abort signal is
  live. Pi's terminal UI clears its queue and aborts in one step, so every steered message predates
  any clear. A message that arrives after the abort or after the agent loop ended is held until the
  run settles, and then wakes the session. The settle releases only messages queued before it.
- A recovered message is shown without starting a new turn. The agent sees it on the next prompt. A
  newly arriving message still wakes the session.

### Answers

A worker answer is one `answer` message that the worker accepts only for its open question. The
stored message, then its receipt, is the durable answer, and no answer file exists. ADR 0125 holds
the question rules.

### Worker news

- A report sets a `tau.report` label, and a question sets a `tau.question` label, on the worker's
  own terminal. The manager subscribes to `hc` events for children of its own terminal over a
  long-lived `hc connect`.
- A child labels change, a child finished event, or a missed snapshot starts at most one pending
  worker scan. Heartbeats and every other event type do nothing.
- After an exit or error, the subscription retries for the whole session with a delay capped at 45
  seconds, and stops at session shutdown. One lasting failure shows one notice per outage, through
  `ui.notify`, never a Pi message.
- Tau starts workers with `no_notify`, so `hc` types no exit note. Only a report, a question, one
  "ended without a report" message, or one "ended at its deadline" message reaches the session. Tau
  puts no event payload, screen, or label dump in message content.
- An arriving message wakes an idle session and steers a running one, through one shared wake rule.

### Bash guard

Every Tau session refuses a bash call that runs `hc send` or `hc keys` in command position, also
inside a literal `sh -c` or `bash -c` script and behind the `command`, `env`, `exec`, `nohup`,
`time`, `sudo`, and `xargs` wrappers. The refusal names `handover` action `send` and
`subagent_answer`. Mentions such as `echo hc send`, `printf` text, quoted heredoc bodies, and
`hc send --help` pass. The guard prevents accidents and is not a security boundary: a command built
from variables, source the shell parser rejects, and a direct `hc connect` call pass.

## Consequences

### Positive

- No agent message mixes with what the user is typing.
- A sender knows whether the receiver saved the message, or knows that it cannot tell.
- A receiver keeps its pending messages across a reload, and a receipt shows each one once.

### Negative

- A session started before this change has no inbox, so a send to it is refused until it reloads.
- The startup gate is best effort, so a message can arrive before an early startup status.
- A crash between display and the session save can show one message twice.
- A lost event subscription delays a report until it reconnects or until session start.

## Alternatives considered

### Keep `hc send` for messages

Rejected because the text joins the user's input, and the sender learns nothing about acceptance.

### Write message files into the receiver's folder

Let the sender write a file and the receiver watch for it, with a lease on the folder. Rejected
because two writers share one folder, and the sender still cannot tell whether a live receiver read
the file.

### Refuse `hc send` inside `hc`

Restrict typing at the `hc` level for agent terminals. Rejected because people use `hc send` on
purpose, and the accident happens in Tau's own bash calls, where a guard is enough.

### Poll `hc ls` for worker news

Rejected because it adds a second source of worker state and a delay, while the event stream already
reports the label and finish changes Tau needs.
