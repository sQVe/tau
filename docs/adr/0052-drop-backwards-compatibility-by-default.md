# ADR 0052: Drop backwards compatibility by default

- Status: Accepted
- Date: 2026-09-27

## Context

- Agents add backwards compatibility without being asked: a deprecated alias next to a renamed
  function, an optional parameter for the old call shape, or a branch that still reads an old config
  key.
- When every caller is in the repository, these paths serve no one, and nobody removes them later.
- Some surfaces have users the agent cannot see. Published packages have npm users, and users type
  CLI commands and write config files.
- Records written by one Tau version are read by another (ADR 0045).
- Deleting the old path on these surfaces breaks something outside the checkout.

## Options considered

- Keep no rule. Agents keep adding shims by reflex.
- Keep compatibility by default. This protects outside users but leaves dead paths in every internal
  rename.
- Always delete the old path. This breaks outside users without warning.
- Delete by default and ask when an outside user may exist. The agent can decide most cases from the
  repository and asks only when it cannot.

## Decision

The coding instructions tell agents to drop backwards compatibility by default. When they change an
interface, they update its callers in the repository and delete the old path. They keep no
deprecated aliases, parameters for the old call shape, branches for old config keys, or re-exports
of moved symbols.

### Ask when an outside user may exist

Before changing a surface that something outside the repository may use, the agent asks the user.
The instructions name who uses the surface, not where the code lives: a published package, API, or
CLI, a config file users own, or data an earlier version saved. A package in the repository with npm
users still counts as published.

### Repository decisions win

A repository convention that already decides compatibility applies without asking, through the
preamble of the coding instructions. ADR 0003 keeps externally observable names stable, and
[ADR 0053](./0053-version-each-saved-record-format.md) governs saved records.

### Stay within the task

The rule covers the interface the agent changes. When deleting the old path is outside the task, the
agent says so instead of keeping both paths.

## Tradeoffs

- Internal renames leave no dead paths.
- Outside users are not broken silently, and the agent does not guess in either direction.
- Cost: agents may ask about surfaces that have no outside users, such as internal caches.
- Cost: prompt instructions cannot stop an agent from claiming that an outside user might exist.

## See also

- [ADR 0003: Stability of externally observable identifiers](./0003-externally-observable-identifiers.md)
- [ADR 0008: Coding instructions](./0008-coding-instructions.md)
- [ADR 0045: Keep worker records per Tau checkout and worktree files in `.tau/`](./0045-keep-worker-records-per-checkout-and-worktree-files-in-tau.md)
- [Agent coding instructions](../../src/extensions/coding/instructions.md)
