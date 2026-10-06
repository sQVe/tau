# ADR 0003: Stability of externally observable identifiers

**Date**: 2026-04-10\
**Status**: Accepted\
**Related**: [ADR 0001 (Application structure)](./0001-application-structure.md)

## Context

Users, scripts, and saved data depend on some names in Tau. For example, users type `/commit` for
the command registered as `'commit'`. Renaming its handler function could tempt someone to rename
the command too, which breaks every use of the old name.

The same risk applies to saved session keys, including Pi custom entry types written to disk. It
also applies to Pi tool names registered via `pi.registerTool` and seen by the model, and to slash
command names registered via `pi.registerCommand` and typed by users. Event type strings passed to
`pi.on` and skill directory names under `skills/`, discovered by Pi, carry the same risk.

## Decision

Renaming code must not change a name used by users, other programs, or saved data as a side effect.
Public names stay stable when code is renamed, so a public name changes only for a separate reason.

### Definition

An externally observable identifier is a name saved to disk, registered with Pi, typed by a user, or
found by Pi in the filesystem.

### Rule

Keep these names unchanged when renaming code. Changing them needs its own reason and a plan for
updating existing users and data. Matching a function name is not enough reason.

## Consequences

### Positive

- Code renames preserve saved state and user commands.
- Changes to public names need a separate decision.
- Users and programs can depend on public names.

### Negative

- Code names and public names may differ.
- New public names need care because changing them later is costly.

## Alternatives considered

### Rename code and public names together

Rename both code and public names together. Rejected because, although it is simple, it can break
saved state and callers.
