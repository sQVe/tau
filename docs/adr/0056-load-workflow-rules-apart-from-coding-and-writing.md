# ADR 0056: Load workflow rules apart from coding and writing

**Date**: 2026-09-28\
**Status**: Accepted\
**Related**: [ADR 0006 (Default writing policy)](./0006-default-writing-policy.md),
[ADR 0008 (Coding instructions)](./0008-coding-instructions.md)

## Context

[ADR 0006](./0006-default-writing-policy.md) loads rules for text, and
[ADR 0008](./0008-coding-instructions.md) loads rules for code.

Rules about how the agent works had no home, so they landed in those files. The coding instructions
held rules about other worktrees, CC Safety Net, and `|| true` probes. The writing instructions told
the agent to keep working when no input is needed.

A rule in the wrong file reads as a rule about the wrong thing. It also makes each file harder to
review against its stated scope.

## Decision

Add `src/extensions/workflow/`. It loads [`instructions.md`](../../src/instructions/workflow.md)
into the system prompt before each ordinary agent run, the same way the coding and writing
extensions load theirs. Loading a third instruction file through its own extension matches
[ADR 0006](./0006-default-writing-policy.md) and [ADR 0008](./0008-coding-instructions.md).

### Boundary

- `writing/instructions.md` governs text the agent writes.
- `coding/instructions.md` governs code the agent writes.
- `workflow/instructions.md` governs how the agent carries out a task. This covers the commands it
  runs, the checkouts it touches, the scope it keeps, and when it stops.

### The CC Safety Net rule is dropped, not moved

The coding instructions told agents to run a command that CC Safety Net may block in its own bash
call. The workflow instructions do not keep it. The blocked command stays blocked either way, and a
bundled refusal only costs rerunning the safe reads beside it. That cost does not justify the prompt
space the rule needs to explain CC Safety Net.

## Consequences

### Positive

- Each rule sits in the file whose scope it matches.

### Negative

- A third policy uses more space in the prompt on every run.
- A third duplicate loader, for the reason [ADR 0008](./0008-coding-instructions.md) gives.

## Alternatives considered

### Keep the rules where they are

Keep the rules where they are. Rejected because, although it needs no change, the boundary
[ADR 0008](./0008-coding-instructions.md) draws keeps eroding.

### Add the rules to the bare root prompt

Add the rules to the bare root prompt. Rejected because that prompt applies only in a bare
repository root.
