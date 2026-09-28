# ADR 0056: Load workflow rules apart from coding and writing

- Status: Accepted
- Date: 2026-09-28

## Context

- [ADR 0006](./0006-default-writing-policy.md) loads rules for text, and
  [ADR 0008](./0008-coding-instructions.md) loads rules for code.
- Rules about how the agent works had no home, so they landed in those files. The coding
  instructions held rules about other worktrees, CC Safety Net, and `|| true` probes. The writing
  instructions told the agent to keep working when no input is needed.
- A rule in the wrong file reads as a rule about the wrong thing. It also makes each file harder to
  review against its stated scope.

## Options considered

- Keep the rules where they are. Needs no change, but the boundary ADR 0008 draws keeps eroding.
- Add the rules to the bare root prompt. That prompt applies only in a bare repository root.
- Load a third instruction file through its own extension. Matches ADR 0006 and ADR 0008.

## Decision

Add `src/extensions/workflow/`. It loads
[`instructions.md`](../../src/extensions/workflow/instructions.md) into the system prompt before
each ordinary agent run, the same way the coding and writing extensions load theirs.

### Boundary

- `writing/instructions.md` governs text the agent writes.
- `coding/instructions.md` governs code the agent writes.
- `workflow/instructions.md` governs how the agent carries out a task. This covers the commands it
  runs, the checkouts it touches, the scope it keeps, and when it stops.

## Tradeoffs

- Each rule sits in the file whose scope it matches.
- Cost: a third policy uses more space in the prompt on every run.
- Cost: a third duplicate loader, for the reason ADR 0008 gives.

## See also

- [ADR-0006: Default writing policy](./0006-default-writing-policy.md)
- [ADR-0008: Coding instructions](./0008-coding-instructions.md)
