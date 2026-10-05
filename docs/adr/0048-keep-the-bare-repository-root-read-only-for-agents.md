# ADR 0048: Keep the bare repository root read-only for agents

**Date**: 2026-09-25\
**Status**: Superseded\
**Superseded by**:
[ADR 0051 (Note the bare root rule instead of enforcing it)](./0051-note-the-bare-root-rule-instead-of-enforcing-it.md)

## Context

The user often talks to a Pi agent started in the bare repository root, where `.git` points to
`.bare`. That agent should open worktrees and hand work over, but it sometimes starts developing in
the root itself. The `subagent` tool requires a worker's directory to match the session's, so a
worker launched from the root would also work there.

## Decision

When `git rev-parse --is-bare-repository` prints `true` in the session directory at session start,
Tau appends a rule to the system prompt and refuses the `write`, `edit`, `subagent`, and
`subagent_follow_up` tools. Adding the rule and refusing the tools that change files or start
workers catches the common case with a clear refusal that names the way out. The rule and the
refusal point to the worktree skill for new work and the handoff skill for work that belongs to an
existing worktree.

Tau checks once per session start, not on every prompt. The refusal overrides any guideline that
asks the agent to delegate to workers.

## Consequences

### Positive

- The root agent reads and answers questions but cannot edit files or launch workers there.

### Negative

- `bash` can still write files in the root. Only the prompt rule covers it, because spotting writes
  in shell commands is unreliable.
- A user who wants a quick edit in the root must start Pi elsewhere.

## Alternatives considered

### Worktree and handoff skills alone

Rely on the worktree and handoff skills alone. Rejected because the agent already ignores them at
times.

### System prompt rule only

Add a rule to the system prompt only. Rejected because, although it is cheap, nothing stops an agent
that disregards it.
