# ADR 0050: Note the bare root rule instead of enforcing it

- Status: Accepted
- Date: 2026-09-25

## Context

[ADR 0048](./0048-keep-the-bare-repository-root-read-only-for-agents.md) refused `write`, `edit`,
`subagent`, and `subagent_follow_up` in a bare repository root. The handoff skill writes its message
with the `write` tool before sending it, so a manager in the root could not hand work off, which is
one of the jobs the root exists for.

## Options considered

- Keep the refusal and allow `write` under `.tau/handoffs`. Adds path rules to a guard that `bash`
  already bypasses, and the next legitimate root task would need another exception.
- Keep only the system prompt rule. It steers the agent without breaking the root's own workflows.

## Decision

In a bare repository root, Tau appends a rule to the system prompt and refuses no tools. The rule
says the root is for reading, answering questions, opening worktrees, and handing off; development
belongs in a worktree; and writing handoff messages under `.tau/handoffs` in the root is fine.

## Tradeoffs

- A manager in the root can hand off work and create worktrees.
- Cost: an agent that ignores the rule can edit files or launch workers in the root.
