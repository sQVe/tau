# ADR 0046: Declare types before values, except types derived with `typeof`

- Status: Accepted
- Date: 2026-09-25

## Context

Tau modules declared some types below the functions and constants that come before their first use.
Readers then find a type in the middle of unrelated code. Reviewers had to catch this by hand, and
[ADR 0034](./0034-check-house-style-outside-the-editor.md) moves mechanical style into checks.

Some types mirror a value in the same module, such as `Static<typeof schema>` for a TypeBox schema
or `ReturnType<typeof build>`. TypeScript resolves type aliases lazily, so these could move above
their value and still compile. The value and its type then sit apart.

## Options considered

- Leave placement to review. Costs nothing, but placement stays inconsistent.
- Hoist every type. Separates each TypeBox type from its schema.
- Exempt types built with named helpers such as `Static` or `ReturnType`. Needs a list that grows
  with every new helper and misses `typeof value` alone.
- Exempt a type that references an exempt type. Keeps chains such as `Extract<Task, { version: 1 }>`
  together, but an interface that only uses a TypeBox type in one field would never move.
- Exempt a type only when it applies `typeof` to a value declared in the same module. Uses the
  reference itself, so it needs no list.

## Decision

Declare module-level types and interfaces, exported or not, below the imports and above values. The
`tau/type-placement` style rule reports a type below a value and moves it there with the comments
directly above it.

A type that applies `typeof` to a value declared in the same module is exempt and stays beside that
value. A type derived only from such a type is not exempt. The rule applies to tests and fixtures as
well.

## Tradeoffs

- Types are found at the top of each module.
- TypeBox types stay beside their schemas without a list of helper names.
- Cost: a type built from a `typeof`-derived type, such as `NativeTask` from `Task`, moves away from
  it.
- Cost: moved types keep their order but are each separated by a blank line.
