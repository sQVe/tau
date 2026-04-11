# ADR 0003: Stability of externally observable identifiers

- Status: Proposed
- Date: 2026-04-10

## Context

- Some strings in Tau's code are contracts with the outside world. Example:

  ```ts
  pi.registerCommand('commit', commitHandler);
  ```

  Users type `/commit` in Pi; that string lives in muscle memory, scripts, and saved sessions.

- Renaming `commitHandler` to `createCommitHandler` tempts a symmetry rename of `'commit'` to
  `'createCommit'`, which silently breaks every user and every persisted session.
- Other surfaces share this pressure:
  - persisted session keys (Pi custom entry types written to disk).
  - Pi tool names registered via `pi.registerTool` and seen by the LLM.
  - slash command names registered via `pi.registerCommand` and typed by users.
  - event type strings passed to `pi.on`.
  - skill directory names under `skills/`, discovered by Pi.
- The rule preventing this breakage was implicit; this ADR makes it explicit.

## Options considered

- **Source drives wire format.** Renaming code renames the external string. Simple, but breaks
  persisted state and external callers on every refactor.
- **Wire format is stable independent of source.** Refactor freely; external strings change only
  when a separate decision demands it.

## Decision

A source rename never changes an externally observable identifier as a side effect.

### Definition

An externally observable identifier is any string that crosses the process boundary: persisted to
disk, registered with Pi by name, typed by a user, or discovered by Pi from the filesystem.

### Rule

A source rename that would cascade into one of these strings stops at the source layer. The external
string changes only when there is a standalone reason to change it, and the change ships with an
explicit migration plan. Symmetry between source and wire format is not a reason on its own.

## Tradeoffs

- Refactors cannot accidentally break persisted state or user workflows.
- Rename decisions stay scoped to source; wire-format changes are deliberate.
- Externally visible names are treated as contracts, not incidental strings.
- Cost: source and wire names may drift apart, which can feel inconsistent.
- Cost: new externally observable identifiers must decide their wire format upfront, because they
  are expensive to change later.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
