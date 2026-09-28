# ADR 0055: Record Tau coding conventions in `AGENTS.md`

- Status: Accepted
- Date: 2026-09-27

## Context

- Agents write nearly all of Tau's code. They copy nearby patterns and follow the coding
  instructions Tau loads into every session (ADR 0008).
- An instruction alone fails when nothing makes the rule the easy path. "Parse untrusted values
  once" was already an instruction, and agents still wrote four task ID parsers (ME-438).
- Agents game proxy checks such as size thresholds (ADR 0035).
- Every instruction line costs context in every session (ADR 0008).
- A multi-model review proposed conventions for module ownership, queries, failures, and mappings.
  It kept only short semantic rules and put the details in ADRs, lint messages, and code examples.

## Options considered

- Add the conventions to the coding instructions. Those instructions load in every repository an
  agent works in, so every session would pay for rules that other repositories may not share.
- Add only general forms of the rules to the coding instructions. They would still set conventions
  for other repositories, which the coding instructions should leave to those repositories.
- Record the conventions in this ADR only. Agents would not see the choices they make before
  designing, such as where code lives, until review.
- Record every convention here, and link to it from `AGENTS.md`, which loads only in Tau. Leave
  syntax to lint messages and examples. Choose this option.

## Decision

Tau adopts the conventions below. Syntax and details stay in lint messages and ADRs.

### Where the rules load

The coding instructions stay unchanged. `AGENTS.md` links to this ADR and states the two rules an
agent needs before designing: the contract test for read paths, and record versioning from ADR 0053.

### Module ownership and dependency direction

- Feature code stays in `src/extensions/<feature>/`. Extensions do not import each other.
- Code moves under `src/` only once two extensions need it. Shared code never imports extensions.
- `tau/extension-boundary` in `scripts/stylePlugin.ts` and the shared-module override of
  `eslint/no-restricted-imports` in `vite.config.ts` enforce both rules (ADR 0001).
- A module that grows subdirectories may mark files private. An override of
  `eslint/no-restricted-imports` in `vite.config.ts` lists the public files, and the rest of the
  extension imports only those. `src/extensions/subagents/controller/` is the first: other subagents
  files import only `controller.ts`, `record.ts`, and `budget.ts`. Tests and fixtures may import any
  file. `tests/lint.test.ts` holds an allowed and a refused fixture for each rule.
- Tau requires no barrel files, no single entry file per subdirectory, and no interfaces for module
  boundaries.

### Queries do not change state

- Functions named `read*`, `get*`, `find*`, `list*`, or `*Status` do not write records, change
  lifecycle state, repair evidence, acknowledge work, or start or stop workers.
- The names guide agents. Contract tests enforce the rule. Every new public read path that touches
  saved records or running workers gets a contract test. It covers normal, missing, and malformed
  evidence, and asserts that saved records are unchanged and that no worker action happened.
- The example to copy is "reads status, history, and widget rows without writing records or stopping
  workers" in `src/extensions/subagents/controller/controller.test.ts`.

### Outcomes versus failures

- Return a discriminated union when callers branch on expected outcomes. Throw for invalid input and
  failed operations.
- Add an `Error` subclass only when production code catches that exact condition, such as
  `EvidenceUnavailableError`.
- Turn errors into user text once, at the tool boundary. `evidenceResult` in
  `src/extensions/subagents/index.ts` is the example.
- Tau adds no generic `Result` type and does not migrate existing code.

### Tables keyed by a union

Use a table keyed by a union for a complete mapping, such as `stateLabels` in
`src/extensions/subagents/presentation.ts` (ADR 0036). Do not use such tables for control flow.

### Record compatibility

The `AGENTS.md` line links to [ADR 0053](./0053-version-each-saved-record-format.md). ADR 0052 lets
that repository decision apply without asking the user.

### Rejected conventions

- `invariant()`. Named narrowing guards such as `requireNativeTask` carry domain meaning that a
  generic assertion loses.
- Branded IDs, for now. Reopen when a concrete signature shows a misuse risk.
- `assertNever()`. The exhaustive-switch lint already covers it.
- An effects-returning state machine, a type per `Handle` phase, and per-harness adapters (ADR
  0033).
- `*Decision.ts` naming as enforcement, a `node:fs` import denylist, and count thresholds. Agents
  satisfy such proxies without meeting the rule behind them (ADR 0035).
- Contract tests only for new tools and widgets. Internal read paths also reach saved records and
  workers, so the requirement covers every public read path.

## Tradeoffs

- Agents working in Tau see the rules they need before designing, and sessions in other repositories
  pay nothing.
- Private subpaths fail lint with a message that names the public files.
- A query that writes state fails a test, whatever the function is named.
- Cost: agents can still misname a function. Only a contract test catches the side effect.
- Cost: the list of public controller files is kept by hand in `vite.config.ts`.
- Cost: agents see the other conventions only if they follow the link to this ADR.

## See also

- [ADR 0001: Application structure](./0001-application-structure.md)
- [ADR 0008: Coding instructions](./0008-coding-instructions.md)
- [ADR 0033: Use one generic native worker workflow](./0033-use-one-generic-native-worker-workflow.md)
- [ADR 0035: Use size thresholds as review guidance](./0035-use-size-thresholds-as-review-guidance.md)
- [ADR 0036: Allowlist worker content and label states from one table](./0036-allowlist-worker-content-and-label-states-from-one-table.md)
- [ADR 0052: Drop backwards compatibility by default](./0052-drop-backwards-compatibility-by-default.md)
- [ADR 0053: Version each saved record format](./0053-version-each-saved-record-format.md)
