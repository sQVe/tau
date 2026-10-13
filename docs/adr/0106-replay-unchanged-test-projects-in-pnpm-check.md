# ADR 0106: Replay unchanged test projects in `pnpm check`

**Date**: 2026-10-12\
**Status**: Accepted\
**Related**: [ADR 0039 (Reuse reported checks and run one full suite per work state)](./0039-reuse-reported-checks-and-run-one-full-suite.md),
[ADR 0005 (Integration testing against a real Pi session)](./0005-integration-testing-with-pi.md)

## Context

Agents and people run `pnpm check` after most changes. It used to run the full test suite each time,
even when a change touched one extension or nothing at all. Most of that time goes to integration
tests that start Git, Pi, and nested Vitest processes.

Vite+ can cache a task and replay its last passing output. It records every file the task reads,
including reads by child processes, and reruns the task when one of them changes. It cannot see
environment variables. It passes only a fixed set of them to a task, and fingerprints only the ones
the task lists.

The integration tests are sensitive to competing processes. More parallel test workers than a full
run uses make the hang-watchdog tests fail.

## Decision

`pnpm check` runs the tests as one cached Vite+ task per Vitest project, and `pnpm test` stays the
uncached full run that CI uses.

### Projects

The suite is split into Vitest projects by area, such as `core`, `pr`, `subagents`, and
`integration`. Each project gets its own cached task, so a change reruns only the projects whose
recorded reads include it. Each test file belongs to exactly one project, and a structure test
enforces this. A new area goes into an existing broad project. Split out a project only when it is
slow and changes often.

### Load

Two project tasks run at once, with three Vitest workers each. This keeps the machine at the six
workers a full run uses.

### Environment

Each project task lists every environment variable whose value can change a test result, such as
`CI`, `PATH`, `HOME`, the temporary directory variables, and `TAU_COLLECTION_TIMEOUT_MS`. A change
to one of them reruns the task. The list leaves out the herdr, Pi, Tau worker, and Git variables.
The tests set those themselves, and they differ per pane or Git hook. A test fails when test code
reads a variable that is neither listed nor known to be set by the tests.

## Consequences

### Positive

- A check on an unchanged tree replays every project in a few seconds.
- A change in one extension reruns only the projects that read it.
- The shell's herdr, Pi, and Git variables do not reach cached test runs, so a run from an agent
  pane or a Git hook gives the same result as one from a plain shell.

### Negative

- A run with an empty cache is slower than `pnpm test`, because fewer workers share the work.
- Most changes under `src/` still rerun the integration projects, because they load most of the
  package.
- Adding or removing any file under `src/` reruns the projects that list those directories.
- The environment test sees only direct reads in test code. A variable read inside a dependency or a
  child process must be added to the list by hand.
- An aborted check can leave Vite+ runtime files in the repository root, which make the next check
  rerun the projects that list the root.

## Alternatives considered

### Run `vp test --changed`

Select tests from the import graph of a Git diff. Rejected because it cannot see files that Git, Pi,
or nested Vitest processes read, and it reruns everything on an unchanged tree that differs from
`HEAD`.

### Cache the suite as one task

Run the whole suite as a single cached task. Rejected because any change reruns every test.

### Run more projects at once

Run three or six project tasks at once with fewer workers each. Rejected because the hang-watchdog
integration tests failed under that load.

### Fingerprint the whole shell environment

Pass and fingerprint every variable, including herdr and Git ones. Rejected because the pane
variables differ in every herdr pane, so the cache would miss in each one. Git hook variables would
also reach the tests' own Git calls.

### Cache tests in CI

Restore the task cache in CI. Deferred because CI runs once per push, and a full uncached run there
guards against a read the cache missed.
