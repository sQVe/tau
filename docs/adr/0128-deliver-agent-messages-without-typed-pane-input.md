# ADR 0128: Deliver agent messages without typed pane input

**Date**: 2026-11-05\
**Status**: Accepted\
**Supersedes**: [ADR 0126 (Deliver worker news through hc events, not typed pane input)](./README.md#retired)\
**Related**:
[ADR 0125 (Run workers as hc children with one assignment file each)](./0125-run-workers-as-hc-children-with-assignment-files.md),
[ADR 0120 (Capability modules with an enforced import table)](./0120-capability-modules-with-an-enforced-import-table.md)

## Context

`hc send` pastes text into a terminal and presses Enter after a pause in typing. When the receiver
is a manager whose user is typing a prompt, the message joins the unfinished text, and Pi submits
both as one instruction. This happened with a peer handover note: it was appended to the user's
half-typed sentence. A prompt rule against unrequested notes did not stop it.

Worker reports and questions already reached the manager through `hc` labels and events. Peer
handovers, manager answers to worker questions, the deadline warning, and ad hoc notes still typed.

An `hc` label names a terminal, not a session. Two Pi processes, a reload, or a session switch can
share one terminal address. `hc` also keeps labels after Pi crashes, so a plain "inbox on" flag can
outlive the session that set it. Pi gives an extension no event for "session ready", and a run
started before Pi reports its status shows the wrong status.

## Decision

No Tau path types into another agent's pane. An agent sends a message by writing a file and setting
an `hc` label, and the receiving session delivers it through the shared wake rule. Typed text cannot
wait for a busy or blocked receiver, and a label can.

### Worker news

A worker reports by setting a `tau.report` label and asks by setting a `tau.question` label on its
own terminal. The manager process subscribes with `events.subscribe` and `children_of` its own
terminal over a long-lived `hc connect`. A child labels change, a child finished event, or a missed
snapshot starts at most one pending worker scan. Heartbeats and every other event type do nothing.

Tau starts workers with `no_notify`, so `hc` types no exit note. Only a report, a question, one
short "ended without a report" message, or one "ended at its deadline" message reaches the session.
The ended message appears once for a finished worker that has a saved assignment, no report, and no
"ended at its deadline" message.

### Inbox messages

- Each Tau session holds a lease on its own terminal: a label that names its session ID and an
  expiry, which it renews while its watch is live. A lease replaces a plain flag, because it ends on
  its own when the session stops renewing it.
- A sender refuses a receiver with no live lease, its own terminal, or a terminal on another
  machine. For a handover, the error names `handover start`. For an answer, it says to restart the
  worker on a current Tau. Nothing is typed as a fallback, and nothing is written.
- The sender copies the message bytes at send time into a versioned envelope that names the target
  terminal, session ID, family, and message ID. A prepared file can change before the receiver reads
  it, and a label can point at any file, so the receiver checks the envelope's location, type, size,
  and target before it delivers it. A refused envelope shows a notice.
- The envelope lives on the sender's disk, so a sender cannot reach another machine.
- The receiver delivers only envelopes for its own session ID. Others stay queued until that session
  returns or the terminal is removed.
- Messages have no order. Delivery is at least once: the receiver saves a receipt per message ID in
  its session before it removes the label, and it skips a message that has a receipt. A crash before
  the receipt is saved can show a message twice. A reload after it is saved does not.
- The receiver deletes an envelope after its receipt is saved and its label is removed. A file left
  behind by a crash is harmless, because no label names it.
- A woken session first waits for a best-effort startup gate, which opens after Pi's startup events.
  Pi has no session-ready event, so another extension's slow `resources_discover` handler can still
  let the first woken run show idle status.
- Each message family keeps its own tool. `handover` `send` carries peer messages and replies, and
  worker answers stay beside their questions.

### Watches and notices

Every event watch treats an event as a signal and reads state with `hc get`. After an exit or error,
a subscription retries for the whole session with a delay capped at 45 seconds, and stops at session
shutdown. One lasting failure shows one notice per outage. Subscription failures and refusals go to
`ui.notify`, never to a Pi message. Tau puts no event payload, screen, or label dump in message
content.

An arriving message wakes an idle session and steers a running one. That wake rule lives in one
shared module that worker delivery, inbox delivery, and mergeWatch use.

### Guard and later changes

A bash guard in every Tau session will refuse the common forms of `hc send` and `hc keys`. It
prevents accidents only. It is not a security boundary: a command in a variable or a direct
`hc connect` call passes it, and any process of the same user can write labels and envelopes.

Worker answers go through the inbox. A later change moves the deadline warning to a timer inside the
worker, so the warning needs no transport. A later change also adds the guard. Until then, the
deadline warning still types.

## Consequences

### Positive

- A message never joins text the user is typing.
- A message to a busy, blocked, or restarting receiver waits and arrives once the session is ready.
- A sender learns at send time when the receiver cannot read an inbox.
- The manager learns about a report or a question from the same state the user sees with `hc ls`.

### Negative

- Only a Tau session with a live lease can receive a message. Other programs get a refusal.
- A lost event subscription delays delivery until it reconnects or until session start.
- A crash between delivery and the saved receipt can show a message twice.
- `hc` and the file system cannot change together, so an envelope with no label or a label with no
  receipt needs a recovery step.
- A finished worker without a report produces one extra message.

## Alternatives considered

### Keep typed input with `hc send`

Keep `hc send` for notes, answers, and handovers, with prompt rules against unrequested notes.
Rejected because typed text joins the user's unfinished prompt, and a prompt rule did not stop it.

### A file-system inbox watched with `fs.watch`

Give each terminal an inbox directory and watch it with `fs.watch`. Rejected because it adds a
second source of terminal state beside `hc` and a second watch and retry scheme, and it gives no
live signal that a receiver is listening.

### One generic message tool

Replace `handover` `send` and worker answers with one `message` tool. Rejected because worker
answers would lose their link to the question record, and worker logic would spread into a general
tool.

### Send one Pi message per hc event

Rejected because events are frequent, and only a report, a question, or an inbox label is news to
the session. An event starts a scan; the scan decides what to show.

### Poll `hc ls` on a timer

Rejected because it adds a second source of worker state and a delay, while the event stream already
reports the label and finish changes Tau needs.
