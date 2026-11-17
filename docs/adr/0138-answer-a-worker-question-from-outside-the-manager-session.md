# ADR 0138: Answer a worker question from outside the manager session

**Date**: 2026-11-17\
**Status**: Accepted\
**Related**: [ADR 0125 (Run workers as hc children with one assignment file each)](./0125-run-workers-as-hc-children-with-assignment-files.md),
[ADR 0129 (Deliver agent messages through each session's inbox socket)](./0129-deliver-agent-messages-through-inbox-sockets.md)

## Context

A worker saves its question in its assignment file and waits for an answer. Today the manager's Pi
session answers it with the `subagent_answer` tool. A program outside that session cannot call a Pi
tool, so it cannot answer a question it can see.

A worker accepts an answer because it comes from its manager. Any new path must keep the manager's
checks and must not let the caller supply the facts those checks rely on.

## Decision

A caller outside the manager session sends an `answer-request` frame to the manager's inbox socket,
and the manager decides whether to queue the answer to the worker.

### The request

- The request is one `rpc1` inbox frame with family `answer-request`.
- The caller sends it to the manager session's inbox socket.
- The caller supplies `assignmentId`, `questionId`, and `answer` only.

### Finding the manager

- The caller finds the live worker terminal whose `tau.assignment` label ends in
  `/<assignmentId>/assignment.json`.
- That terminal's `hc` parent is the manager terminal, which becomes `targetTerminal`.
- The manager terminal's `tau.inbox` label gives the socket path. The socket file name
  `<sessionId>.sock` gives `targetSessionId`, as the target decision in
  `src/inbox/targetDecision.ts` reads it.
- `messageId` is a new UUID for the request, and a retry reuses it.
- The caller waits more than 5 seconds for a reply, because the manager waits up to 5 seconds for
  the worker.

### Authority

- The manager session runs the same checks as `subagent_answer`: the assignment exists, it belongs
  to this manager session, it has no report, and the question is the latest.
- The manager then queues the correlated `answer` message to the live worker.
- The manager supplies its own session file and its own `hc` runtime, which carries its working
  directory. The caller cannot name them.
- The socket folder is readable only by the user, so the same user is the authority boundary.

### The reply

- The reply is `queued`, `refused` with a reason, or `unknown`.
- `queued` means the worker's inbox saved the answer, not that the worker read it.
- `unknown` means the manager wrote the answer to the worker but got no reply. A retry with the same
  question ID and text is safe.
- The manager handles each answer request when it arrives. It does not queue the request behind
  other inbox messages.
- The worker's inbox decides between competing answers. It keeps the first saved answer for a
  question ID and refuses a different later answer.

### Pinning the contract

A caller pins the frames in `src/inbox/fixtures/answerRequest/` by Tau commit, as
[ADR 0127](./0127-version-the-draft-review-viewer-protocol.md) does for the viewer protocol.

## Consequences

### Positive

- A program outside the manager session can answer a worker question without joining that session.
- The manager keeps one authority check for both its own tool and an outside caller.
- The caller learns whether the answer was saved, refused, or left in doubt.

### Negative

- A caller must discover the manager through `hc` labels and the socket file name.
- Same-user access to the socket folder is the only identity check.
- An `unknown` reply requires a retry with the same question ID and text.
- A protocol change needs new fixtures, because callers pin the old ones by Tau commit.

## Alternatives considered

### A Tau CLI command

Add a command that finds the manager and sends the request. Rejected because Tau has no CLI entry
point, and a caller would need a checkout path.

### The caller sends the `answer` family to the worker

Let the caller send the answer straight to the worker's inbox. Rejected because the worker would
trust the caller for the manager's authority.

### A saved request file

Write the request into the manager's folder and let it read the file. Rejected because the sender
cannot tell whether a live receiver read it, per
[ADR 0129](./0129-deliver-agent-messages-through-inbox-sockets.md).
