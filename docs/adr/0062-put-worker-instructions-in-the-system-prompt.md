# ADR 0062: Put worker instructions in the system prompt

- Status: Accepted
- Date: 2026-09-28

## Context

A worker's profile and its assignment and handoff contracts arrived in its first user message, next
to the task. A follow-up opens the saved session with a new task, so the same text arrived again
with each follow-up, and compaction could summarize it away. Much of it also repeated tool
descriptions and guards that the worker already sees.

## Options considered

- Keep the instructions in the first user message. Nothing changes, but the costs above remain.
- Write them to a private file and pass it with Pi's `--append-system-prompt`. This is how Pi
  Herdsman does it, but the flag replaces Pi's discovered `APPEND_SYSTEM.md`, so workers would lose
  the user's own appended prompt.
- Append them in the worker extension's `before_agent_start` hook, as Tau's coding, writing, and
  workflow instructions are appended.

## Decision

The worker extension appends the saved profile body and the contracts to the system prompt in
`before_agent_start`. The first user message holds only the task ID, the task, and its deadline.

- Each process reads the instructions from its own saved task, so a follow-up gets them without
  resending.
- Worker instructions state only what no tool description or guard already states.

## Tradeoffs

- Compaction keeps the instructions, and follow-ups do not repeat them.
- Workers keep the user's `APPEND_SYSTEM.md`, and no argument or extra file carries the prompt.
- Cost: the instructions no longer appear in the session transcript, so reading a worker's session
  file does not show what it was told.

## See also

- [ADR 0056: Load workflow rules apart from coding and writing](./0056-load-workflow-rules-apart-from-coding-and-writing.md)
