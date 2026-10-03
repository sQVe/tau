# ADR 0057: Enforce pure decision modules from a registry

- Status: Accepted
- Date: 2026-09-28

## Context

- `deriveWorkerState` decides a worker's state from facts, and `workerState.test.ts` checks it with
  a decision table. Later lifecycle rules, such as queues, retries, and capacity, should take the
  same shape.
- Agents copy nearby code. When a module mixes reads and decisions, copies mix them too.
- Agents satisfy proxy checks without meeting the rule behind them (ADR 0035). A `node:fs` import
  ban misses modules that reach the disk through `records.ts`, and a `*Decision.ts` name rule misses
  a renamed file (ADR 0055).
- The clock, randomness, and the environment are effects as well as disk reads.

## Options considered

- Rely on the convention and review. Rejected: the mixed module already shows that copies drift.
- Ban `node:fs`, or require a file name. Rejected: both are proxies that agents bypass.
- Add a rule to `lint/plugin.ts`. Rejected: its registry would live in `vite.config.ts`, and lint
  fixtures could not register their own modules without test hooks in the configuration.
- Keep a registry in `tests/structure.test.ts` and parse each registered module there. Chosen: the
  check follows imports, not names, and needs no test hooks in the configuration.

## Decision

Tau keeps an explicit registry of pure modules, `pureModules` in `tests/structure.test.ts`, and
fails the suite when a registered module does any of these:

- imports at runtime from anything but another registered module (`import type` and `export type`
  are allowed);
- imports dynamically or calls `require`;
- uses `Date.now`, `Date()`, `new Date()` without arguments, `performance.now`, `Math.random`, or
  `process.env`.

The failure tells the agent to move the read or effect to the caller and pass the value in as a
fact. Callers read first and then decide. Effect callbacks are not facts.

`src/extensions/subagents/workerState.ts` is the first registered module, and its decision table in
`workerState.test.ts` is the example to copy. Register other modules when they are split for their
own reasons. `AGENTS.md` states the rule beside the conventions from ADR 0055.

## Tradeoffs

- The check follows imports, not names, so renaming a file or routing a read through another module
  does not escape it.
- Decision rules can be tested as tables without temporary directories or fake clocks.
- Cost: an unregistered module is not checked. Agents must register a module when they split it.
- Cost: the check does not see effects passed in as callbacks, reached through aliases such as
  `globalThis` or destructuring, or reached through globals it does not list.
- Cost: `oxc-parser` becomes a direct development dependency.

## See also

- [ADR 0035: Use size thresholds as review guidance](./0035-use-size-thresholds-as-review-guidance.md)
- [ADR 0055: Record Tau coding conventions in `AGENTS.md`](./0055-record-tau-coding-conventions-in-agents-md.md)
