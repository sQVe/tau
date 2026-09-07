# ADR 0003: Stability of externally observable identifiers

- Status: Proposed
- Date: 2026-04-10

## Context

- Other programs and users depend on some names in Tau. For example:

  ```ts
  pi.registerCommand('commit', commitHandler);
  ```

  Users type `/commit` in Pi. Scripts and saved sessions may also use that name.

- Renaming `commitHandler` to `createCommitHandler` might lead someone to rename `'commit'` to
  `'createCommit'` too. That would break uses of the old command.
- The same risk applies to:
  - saved session keys, including Pi custom entry types written to disk.
  - Pi tool names registered via `pi.registerTool` and seen by the model.
  - slash command names registered via `pi.registerCommand` and typed by users.
  - event type strings passed to `pi.on`.
  - skill directory names under `skills/`, discovered by Pi.
- This ADR records when these names may change.

## Options considered

- Rename both code and public names together. Simple, but can break saved state and callers.
- Keep public names stable when renaming code. Change a public name only for a separate reason.

## Decision

Renaming code must not change a name used by users, other programs, or saved data as a side effect.

### Definition

An externally observable identifier is a name saved to disk, registered with Pi, typed by a user, or
found by Pi in the filesystem.

### Rule

Keep these names unchanged when renaming code. Changing them needs its own reason and a plan for
updating existing users and data. Matching a function name is not enough reason.

## Tradeoffs

- Code renames preserve saved state and user commands.
- Changes to public names need a separate decision.
- Users and programs can depend on public names.
- Cost: code names and public names may differ.
- Cost: new public names need care because changing them later is costly.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
