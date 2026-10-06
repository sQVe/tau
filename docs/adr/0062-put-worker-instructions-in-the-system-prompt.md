# ADR 0062: Put worker instructions in the system prompt

**Date**: 2026-09-28\
**Status**: Superseded\
**Superseded by**:
[ADR 0066 (Add Tau's prompt text to Pi's append section)](./0066-add-taus-prompt-text-to-pis-append-section.md)\
**Related**:
[ADR 0066 (Add Tau's prompt text to Pi's append section)](./0066-add-taus-prompt-text-to-pis-append-section.md),
[ADR 0056 (Load workflow rules apart from coding and writing)](./0056-load-workflow-rules-apart-from-coding-and-writing.md)

## Context

A worker's profile and its assignment and handoff contracts arrived in its first user message, next
to the task. A follow-up opens the saved session with a new task, so the same text arrived again
with each follow-up, and compaction could summarize it away. Much of it also repeated tool
descriptions and guards that the worker already sees.

## Decision

The worker extension appends the saved profile body and the contracts to the system prompt in
`before_agent_start`, as Tau's coding, writing, and workflow instructions are appended. The first
user message holds only the task ID, the task, and its deadline. Compaction then keeps the
instructions, follow-ups do not repeat them, and workers keep the user's `APPEND_SYSTEM.md`.

### Instruction rules

- Each process reads the instructions from its own saved task, so a follow-up gets them without
  resending.
- Worker instructions state only what no tool description or guard already states.

## Consequences

### Positive

- Compaction keeps the instructions, and follow-ups do not repeat them.
- Workers keep the user's `APPEND_SYSTEM.md`, and no argument or extra file carries the prompt.

### Negative

- The instructions no longer appear in the session transcript, so reading a worker's session file
  does not show what it was told.

## Alternatives considered

### First user message

Keep the instructions in the first user message. Rejected because, although nothing changes, the
costs above remain.

### Private file with `--append-system-prompt`

Write the instructions to a private file and pass it with Pi's `--append-system-prompt`, as Pi
Herdsman does. Rejected because the flag replaces Pi's discovered `APPEND_SYSTEM.md`, so workers
would lose the user's own appended prompt.
