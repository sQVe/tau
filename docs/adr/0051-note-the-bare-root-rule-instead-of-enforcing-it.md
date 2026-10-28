# ADR 0051: Note the bare root rule instead of enforcing it

**Date**: 2026-09-25\
**Status**: Accepted\
**Supersedes**: [ADR 0048 (Keep the bare repository root read-only for agents)](./README.md#retired)

## Context

An agent started in the bare repository root, where `.git` points to `.bare`, should open worktrees
and hand work over. Some agents start developing in the root itself.

Refusing `write` in the root blocks the handover skill. That skill writes its message with `write`
before sending it, so a manager in the root could not hand off work, which is one of the jobs the
root exists for.

## Decision

Tau checks once at session start whether the directory is a bare root. In a bare root, Tau appends a
rule to the system prompt before each agent turn and refuses no tools. Keeping only the prompt rule
steers the agent without breaking the root's own workflows. The rule says:

- The root is for reading, answering questions, opening worktrees, and handing off work.
- Development belongs in a worktree. Open one with the worktree skill for new work, and pass work
  that belongs to an existing worktree on with the handover skill.
- Writing handover messages under `.tau/handovers` in the root is fine.
- Before planning work for a worktree, read the selected worktree's `AGENTS.md` and its other
  applicable rules. Plan against the default worktree only when no worktree is selected.
- Read the applicable rules again when you switch worktrees.

## Consequences

### Positive

- A manager in the root can hand off work and create worktrees.

### Negative

- An agent that ignores the rule can edit files or launch workers in the root.

## Alternatives considered

### Allow `write` under `.tau/handovers`

Refuse `write` in the root, and allow it under `.tau/handovers`. Rejected because it adds path rules
to a guard that `bash` already bypasses, and the next legitimate root task would need another
exception.
