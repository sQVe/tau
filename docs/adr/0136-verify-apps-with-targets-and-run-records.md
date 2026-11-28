# ADR 0136: Verify apps with targets and run records

**Date**: 2026-11-16\
**Status**: Accepted\
**Related**: [ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md),
[ADR 0061 (Keep Tau config in a user file and a trusted repository file)](./0061-layer-tau-config-from-user-and-repository-files.md),
[ADR 0105 (Queue full checks per checkout and reuse checks by identity)](./0105-queue-full-checks-per-repository-and-reuse-passing-logs.md),
[ADR 0132 (Keep QA journeys in separate files)](./0132-keep-qa-journeys-in-separate-files.md)

## Context

Apps were checked by hand, and the result lived in prose in a pull request or a worker report. Prose
cannot say which tree was tested, so a passing note from an old checkout looks like evidence for the
current one. A QA run also left no lasting record of which journeys ran or what each step showed.

Tau already saves versioned records for other commands, and a pure rule decides whether a saved
check still applies to the current tree
([ADR 0105](./0105-queue-full-checks-per-repository-and-reuse-passing-logs.md)). App verification
needs the same proof for a journey with several steps.

## Decision

Tau verifies an app through named targets in the trusted repository config, saves one run record per
run, and reads those records instead of parsing QA prose.

### Targets

- Each app declares named targets under `verification.targets` in `.pi/tau.json`.
- Each target gives launch, doctor, and stop argv. They use the same trust gate and argv validation
  as `fullCheck.argv` ([ADR 0061](./0061-layer-tau-config-from-user-and-repository-files.md)).
- Tau owns the verification contract and the QA flow. Each app owns its commands.

### Entry commands

- Each entry command must exit. Tau runs it with a deadline, and runs stop after a launch timeout or
  a cancelled launch, so a hung or abandoned launcher cannot hold the run.
- A stop that is cancelled, cannot start, or does not exit 0 saves nothing, so the manager can call
  stop again. The attempt stays in its log. Only a stop that exits 0 marks the run stopped.
- Tau passes `TAU_VERIFICATION_RUN` and `TAU_VERIFICATION_DIRECTORY`. Each app derives its instance,
  such as a port or socket, from the run, so two runs do not collide.
- Doctor exits non-zero when the running build does not match the checkout, not only when the app is
  down. A running old build is not evidence for the current tree.

### Run directory and writers

- Tau uses two roots. The checkout root comes from `findTauRoot`, and it serves target
  configuration, command working directories, and tree identity. The shared repository root comes
  from `findSharedRepositoryRoot` in `src/tauDirectory.ts`, and it serves the run directory and item
  records.
- Each run lives in `<shared repository root>/.tau/verification/<run>/`. A normal clone shares its
  main checkout, and its linked worktrees use that same main checkout. A linked worktree backed by a
  separate bare repository uses the bare repository root. Every worktree and the main checkout of
  one repository read the same runs, and sibling repositories stay apart.
- Callers must stop a run from the checkout that launched it. Stop runs in that checkout and reads
  its tree identity, so the proof names the tree the run tested. Tau does not record or check which
  checkout launched the run.
- Stop never deletes a run directory, so the proof survives cleanup.
- Runs made before this location stay in their checkouts and are not migrated. Tau no longer
  discovers a run outside the shared root, while a run already under the shared root remains
  visible.
- Only the manager's tool writes `run.json`. Each item result is its own file, `items/<item>.json`,
  written by the `qa` worker's tool. No two writers share a file, so no lock is needed.
- Each item file is published atomically and never replaces an existing file. Two workers that
  record the same item in one run cannot both succeed; the later write refuses with the
  registered-item error.
- The run and item files are versioned saved records, and the schemas live in
  `src/verification/records.ts`. [ADR 0053](./0053-version-each-saved-record-format.md) owns their
  versions, reader outcomes, atomic publication, and fixtures.

### Results

- A step result is passed, differs, blocked, or not run. Blocked and not run never count as a pass,
  so missing coverage stays visible.

### Freshness

- A run is fresh when the tree identity at launch equals the one at stop and the current one, doctor
  exited 0, and the saved stop exited 0. A saved stop that did not exit 0 is not fresh. A null
  identity is never fresh, because an unknown tree can never be shown to match.
- The identity is the content-based tree identity from
  [ADR 0105](./0105-queue-full-checks-per-repository-and-reuse-passing-logs.md).

### Selection

- Selection prefers the newest fresh result per target and item from stopped runs. A newer failure
  wins over an older pass, and a narrower newer run does not hide an earlier item.
- When no fresh result exists for a target and item, selection returns the newest stale result with
  its reason, so a reader can show stale evidence as stale. A stale result never counts as passing
  evidence.

### What Tau parses

- Tau parses run records. Journey and feature files stay unparsed, because
  [ADR 0132](./0132-keep-qa-journeys-in-separate-files.md) keeps them a reader convention.

## Consequences

### Positive

- A cited verification result names the tree it tested and its platform, so a reader can tell fresh
  evidence from stale evidence.
- Each item result is saved on its own, so a worker needs no shared lock and a stopped run keeps all
  of its proof.
- Blocked and not run steps are recorded as such, so partial coverage cannot pass as a full pass.
- A newer failure or a narrower run cannot be hidden by an older or wider pass.

### Negative

- An item result is published once. A second writer for the same item gets a refusal instead of
  replacing the first result.
- Fresh evidence needs a launch, doctor, drive, and stop after each change, so a full verification
  costs more than a prose note.
- An app must keep three working entry commands, and a broken doctor hides its evidence.
- A run directory is never deleted by stop, so `.tau/verification/` grows until someone removes old
  runs.

## Alternatives considered

### Extending `checkRecord` and the full check

Reuse the saved full check record and its queue for app verification. Rejected because a check
record is one command with one pass flag, and the queue and lock serve that command. A journey with
several steps and one result per item does not fit that shape.

### A structured `qa` report in the worker assignment

Have the `qa` worker return a structured report in its assignment record. Rejected because the
report lives with worker records, not in `.tau/verification/`, and other extensions cannot import
the subagents extension. A scripted drive would also have no writer.

### One shared `run.json` with a lock

Keep the manager and every worker writing one run file, guarded by a lock. Rejected because each
write needs the lock, and the manager and workers would depend on one shared file. One file per
writer removes the shared file and the lock.
