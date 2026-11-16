# ADR 0137: Replay generated order failures as decision table rows

**Date**: 2026-11-16\
**Status**: Accepted\
**Related**: [ADR 0121 (Test architecture rules for placement, naming, fakes, and fixtures)](./0121-test-architecture-rules.md),
[ADR 0113 (Mutation-test changed lines and list survivors as advice)](./0113-run-diff-scoped-mutation-testing-by-hand.md)

## Context

Some modules depend on the order of earlier calls. A worker delivery shows one report notice and at
most one final notice per worker, and a repeated poll, a session switch, or a restart can break that
promise. Example tests cover the orders that someone thought of. The orders that nobody wrote stay
untested, and a reader cannot tell which orders the module allows.

A decision table holds every case of a module, so a generated test that finds a new order must leave
a case behind. Otherwise the table stops being the full list that ADR 0121 rule 2 promises.

## Decision

A module whose output depends on the order of earlier calls may have one generated order test that
drives its real adapter, and every shrunk failing order becomes a row in the module's decision
table.

### The generated test

- The test drives the real adapter, not a model of it, so a failure is a failure of the module.
- The file is named for its owner and behavior, such as `workerDeliveryOrdering.test.ts`, never for
  the technique. Rule 1 of ADR 0121 still holds.
- The test runs with a fixed seed in `pnpm check`, so a check and a mutation reuse see the same
  orders. `TAU_PROPERTY_SEED=random` picks a seed by hand and prints it, and an integer replays that
  seed.
- A shrunk failing order is replayed as a row of the facts and plan it reduces to. Orders that
  reduce to the same facts and plan share one row, because the decision function sees only those
  facts. The table still holds every case, and the generated test keeps looking for orders that no
  row names.

### The library

fast-check is the library. It runs inside Vitest and needs no Java, so the test needs no extra
runtime.

## Consequences

### Positive

- Orders that nobody wrote a test for can fail the suite.
- A found order stays as a readable row, so a reader sees the case without reading the generator.
- A fixed seed keeps checks and mutation reuse repeatable.

### Negative

- A generated test can fail on a seed that a later change makes fail, so the fixed seed needs a
  deliberate update.
- The generator and the decision table describe the same module in two places, and both need care
  when the module changes.

## Alternatives considered

### A formal model checker

A model checker explores every interleaving of the module's calls. Rejected because it needs Java,
and it adds a second description of the module that drifts from the adapter.

### A random seed in `pnpm check`

Draw a new seed on every run. Rejected because a check and a mutation reuse would see different
orders, so a failure would not repeat.

### Example tests only

Write each order as a hand-written test. Rejected because it misses the orders that nobody wrote.
