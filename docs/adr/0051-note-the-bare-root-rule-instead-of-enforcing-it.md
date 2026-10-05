# ADR 0051: Note the bare root rule instead of enforcing it

**Date**: 2026-09-25\
**Status**: Accepted

## Context

[ADR 0048](./0048-keep-the-bare-repository-root-read-only-for-agents.md) refused `write`, `edit`,
`subagent`, and `subagent_follow_up` in a bare repository root. The handoff skill writes its message
with the `write` tool before sending it, so a manager in the root could not hand work off, which is
one of the jobs the root exists for.

## Decision

In a bare repository root, Tau appends a rule to the system prompt and refuses no tools. Keeping
only the system prompt rule steers the agent without breaking the root's own workflows. The rule
says the root is for reading, answering questions, opening worktrees, and handing off; development
belongs in a worktree; and writing handoff messages under `.tau/handoffs` in the root is fine.

## Consequences

### Positive

- A manager in the root can hand off work and create worktrees.

### Negative

- An agent that ignores the rule can edit files or launch workers in the root.

## Alternatives considered

### Allow `write` under `.tau/handoffs`

Keep the refusal and allow `write` under `.tau/handoffs`. Rejected because it adds path rules to a
guard that `bash` already bypasses, and the next legitimate root task would need another exception.
