# ADR 0149: Ask the lead that sent a handover

**Date**: 2026-11-23\
**Status**: Accepted\
**Related**: [0138 (Answer a worker question from outside the manager session)](./0138-answer-a-worker-question-from-outside-the-manager-session.md),
[0139 (Split the manager role into a lead and an architect)](./0139-split-the-manager-role-into-a-lead-and-an-architect.md),
[0053 (Version each saved record format)](./0053-version-each-saved-record-format.md)

## Context

A handover starts a session or adds a message to a running one. The receiver often needs a decision
to continue, and the tool that asks opens a dialog in the receiver's own terminal. When the receiver
was started by another session, that dialog reaches the receiver's user instead of the lead that
sent the work. The user then relays the question, or answers work that belongs to the sender.

A receiver can know its sender only from the message it received. A session resumed from a saved
transcript has no live link to the sender, so the message itself must carry the sender and stay in
the transcript.

## Decision

A handover session asks the lead that sent the handover, and only a lead records itself as the
sender.

### Only a lead is a sender

A session records itself as sender only when its role is `lead` and it has a terminal and a session
ID. An architect and a worker send handovers too, but they do not answer for the user, so their
messages carry no sender. A session without a role is a lead, as
[ADR 0139](./0139-split-the-manager-role-into-a-lead-and-an-architect.md) says.

### Carry the sender in the message and the start environment

`handover send` adds `sender: { terminal, sessionId }` to the `handover` payload. `handover start`
passes `TAU_HANDOVER_SENDER_TERMINAL` and `TAU_HANDOVER_SENDER_SESSION` to the new tab and puts the
same sender line first in the task text:

```text
Handover sender: terminal <terminal>, session <sessionId>.
```

The line also appears above the handover text that a receiver shows, so a resumed session finds the
sender in its saved transcript with no other record.

### Take the newest sender, then the environment

A session reads its handover messages and its first task message, oldest first. The newest message
whose first line is a sender line gives the sender. An inbox handover counts as the newest message
even before Pi adds it to the branch. Without such a line, both environment variables give the
sender when the terminal is one non-empty token without whitespace, the session ID is non-empty, and
it matches Pi's session ID rule. Without either, the session has no sender and asks its user.

The newest message wins because a session can receive several handovers, and the latest one names
the session that currently sends it work.

### Treat a sender line as data, not as handover text

A handover file whose first line is a sender line is refused. A file that could pose as a sender
would let its author redirect the receiver's questions.

A receiver puts a fixed `Handover text without a sender:` line above sender-free text whose first
line is a sender line. So only a payload `sender` or the start environment and task line give a
sender, whatever Tau version sent the text.

### Keep the saved handover record compatible

Version 2 of the saved inbox record added the optional `sender` field and still reads version 1.
Version 3 added the `handover-question` family. Both older versions stay readable, as
[ADR 0053](./0053-version-each-saved-record-format.md) says. A pending retry compares the payload
without the version, and a retry whose sender differs is a changed message. A receiver on an older
Tau refuses a frame that carries `sender`; that refusal is accepted and needs no fallback.

The Pi session receipt moves to version 3 when it gains the `handover-question` family. It still
reads version 2 for `handover` and `answer`, and it skips a version 2 `handover-question` receipt.
An older Tau skips a version 3 receipt, and it also skips the version 3 inbox record that would be
replayed, so no message is delivered twice.

### Ask with handover_question

A lead session gets the `handover_question` tool only when it finds a sender. When the tool runs, it
resolves the sender again from the current branch and environment, so a branch without a sender
refuses and saves nothing. The tool saves an open question record in the asker's checkout, sends a
saved `handover-question` frame to the sender's session, and ends the turn. Before it saves, the
tool checks that the asker's own inbox is listening, so the answer can reach it. Without that inbox,
the tool saves nothing and tells the asker to ask its user. A refused send deletes the record and
tells the asker to ask its user.

### Ask the user when the sender is gone

An ended sender makes the asker ask its user. A dead terminal cannot answer, and waiting on it would
stall the work.

## Consequences

### Positive

- A receiver asks the session that sent the work, so the user no longer relays questions.
- The sender survives in the transcript, so a resumed session finds it.
- A message with no sender keeps the current behavior, so other senders need no change.

### Negative

- A handover message and a started task from a lead carry one extra line; one without a sender
  carries none, unless its first line is a sender line.
- An older Tau refuses a handover frame with a sender, so mixed versions cannot exchange one.
- A session with no usable sender in its transcript or environment still asks its user.
- A current sender refuses a handover file whose first line is a sender line, and a receiver shows
  such text from any other source with the escape line first.
- A sender line already saved in a transcript before the upgrade, or in the task of a session that
  an older Tau's `handover start` opened, still reads as a sender. A fresh session without the old
  transcript drops it.

## Alternatives considered

### Keep the sender only in the environment

Pass the sender through environment variables for both `send` and `start`. Rejected because a
running receiver never sees the environment of a new handover, and a resumed session loses it.

### Save a separate sender record per session

Write the sender to a file next to the session and read it back. Rejected because the record would
need its own version and lifetime, while the transcript already holds the handover text.

### Ask the user when several handovers arrived

Keep the first sender, or ask when senders disagree. Rejected because the newest handover is the
work the session currently acts on, and asking would add a dialog the sender can answer.
