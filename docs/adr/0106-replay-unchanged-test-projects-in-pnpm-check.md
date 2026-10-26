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
`CI`, `HOME`, the temporary directory variables, and `TAU_COLLECTION_TIMEOUT_MS`. A change to one of
them reruns the task. The list leaves out the herdr, Pi, Tau worker, and Git variables. The tests
set those themselves, and they differ per pane or Git hook. A test fails when test code reads a
variable that is neither listed nor known to be set by the tests.

`PATH` works differently. Vite+ does not track files outside the workspace, so a fingerprint of the
`PATH` text cannot see a change to the file `node` or `pnpm` resolves to. `pnpm check` runs
`scripts/runTestProjects.ts`, which passes a SHA-256 digest of the executables on `PATH`. The digest
covers, for each command name, every executable file with that name in `PATH` order. Shadowed
executables count because some tests drop the package bin directories from `PATH` and run the
command behind them, such as the installed `pi`. The tasks fingerprint that digest in place of
`PATH`.

A reorder or a duplicate directory leaves the digest the same only while each command name keeps the
same files in the same order. A new executable, or a different file for an existing name, changes
it. A file counts only when the caller can execute it, as checked by `accessSync` with `X_OK`. A
directory does not count. A file counts by its device, inode, size, modification time, and change
time, not its content. The script reads them as `bigint` values, so a large inode number keeps every
digit. Every write updates the change time, and normal tools cannot set it back, so a rewrite that
restores size and modification time still changes the digest.

When a `PATH` directory exists but cannot be listed, the script cannot know its commands. It passes
a random value in place of the digest, so every project runs, and it prints one line to stderr that
names the directory.

A task run outside `pnpm check`, such as `vp run vitest:core`, has no digest, so it fingerprints the
raw `PATH` text.

### Repository root

Vite+ records the directory listings a task reads, and input globs do not remove them. Some projects
list the repository root, so a new entry there reruns them. Tools that `pnpm check` and the mutation
check run keep their temporary files and logs out of the root, for example under `.tau/`. Stryker
writes no log file and keeps its sandbox in `.tau/stryker-tmp`.

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
- Each `pnpm check` reads every `PATH` directory and checks each entry before the tasks start.
- Adding, removing, or changing any executable on `PATH` reruns every project, even one that no test
  runs.
- A `PATH` directory that cannot be listed, such as one with execute but no read permission, makes
  every check run every project.
- A check that does not run through `pnpm check` misses the cache after a `PATH` reorder or
  duplicate, because it fingerprints the raw `PATH` text.
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

### Fingerprint the raw `PATH` when a directory cannot be listed

Fall back to the `PATH` text when the script cannot list a `PATH` directory. Rejected because the
fallback also drops the file check for every directory it could list, so a changed `node` or `pi`
there would replay a stale result.

### Cache tests in CI

Restore the task cache in CI. Deferred because CI runs once per push, and a full uncached run there
guards against a read the cache missed.
