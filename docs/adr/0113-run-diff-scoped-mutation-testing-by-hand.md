# ADR 0113: Run diff-scoped mutation testing by hand

**Date**: 2026-10-16\
**Status**: Accepted; exit codes, repository scope, and test selection superseded by [ADR
0115][adr-0115]

## Context

`run_tests` shows that a test failed and then passed. It does not show that the test pins the
behavior. A mutation tool changes the code and reports the changes no test notices. A trial of
StrykerJS on recent Tau commits found real gaps, such as a regular expression that could lose a
quantifier with every test still passing.

A full mutation run over Tau takes far too long to repeat, and most mutants sit in code a change did
not touch. Some survivors are also equivalent changes that no test can catch, so a person must read
the list.

## Decision

Tau offers `pnpm mutation <base> [<head>]` as a manual check for Tau's own repository. It runs
StrykerJS only on the production lines that changed between base and head, and lists each surviving
mutant. It is not part of `pnpm check`, not a CI job, and not offered to user repositories.

The script exports the head commit into a temporary directory and runs there, so it can check a
commit the script did not exist in. It runs the unit tests of the changed area only, because a full
run is slow and Stryker's own test selection found almost no tests in Tau.

Surviving mutants are a prompt to read, not a failure. The script exits 0 whether or not mutants
survive.

## Consequences

### Positive

- A reviewer sees untested behavior in a change in about a minute.
- The check costs nothing when nobody runs it.

### Negative

- Nobody enforces it, so it only helps when someone remembers to run it.
- It pins the Stryker version to what works with Vitest 4 and TypeScript 7, and needs a workaround
  for both.
- The reader must tell real gaps from equivalent changes.

## Alternatives considered

### Require mutation testing in `pnpm check` or CI

Rejected because survivors include equivalent changes, so a hard gate would fail changes that have
no fix. The run time would also slow every check.

### Mutate the whole repository

Rejected because the run takes too long to repeat, and it reports survivors in code the change did
not touch.

### Select tests with Stryker's related-test mode

Rejected because it selected few or no tests for Tau changes. The script uses a fixed test scope per
changed area.

[adr-0115]: ./0115-copy-mutation-script-per-repository-and-fail-on-survivors.md
