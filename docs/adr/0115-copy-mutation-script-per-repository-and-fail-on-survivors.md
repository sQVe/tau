# ADR 0115: Copy the mutation script into each repository and fail on survivors

**Date**: 2026-10-16\
**Status**: Accepted\
**Related**: [ADR 0113 (Run diff-scoped mutation testing by hand)](./0113-run-diff-scoped-mutation-testing-by-hand.md)

## Context

ADR 0113 made mutation testing a Tau-only check that exits 0 whether or not mutants survive. That
left the check unusable as a gate and unusable in other repositories. A survivor had no required
action, so a reader could skip it.

Each survivor on a changed line has a way out: a test that kills it, simpler code, or a comment for
a true equivalent change. A failing exit code is now safe to use.

## Decision

Each repository checks in a Stryker config and its own copy of `scripts/mutation.ts`,
`scripts/mutationScope.ts`, and `scripts/mutationReport.ts`. The script holds no repository-specific
path. It prints the JSON report that `scripts/mutation.md` defines.

In `changed` mode the script exits 2 when mutants survive. In `audit` mode it exits 0 on survivors.
When the mutant cap leaves a file unmutated, the script exits 1 in both modes, so a skipped file
never looks like a pass.

A survivor on a changed line is resolved in one of three ways: add a test, simplify the code, or
write `// Stryker disable next-line <mutator>: <reason>` for a true equivalent change.

Tau's Stryker config uses related-test mode (`vitest.related: true`), so Stryker runs only the tests
that relate to the mutated files. Running all unit tests hit Stryker's 5 minute dry-run limit. On
the six tuning commits, related mode killed most mutants. Killed and uncovered mutants per commit:
`e9696243` 294 of 428 and 44, `23f561ec` 124 of 143 and 2, `290ea97f` 88 of 112 and 6, `a242c016` 36
of 50 and 1, `cdb006a5` 18 of 22 and 1, `fd5d2213` 10 of 13 and 0. See
[the tuning note](../../scripts/mutation-tuning.md).

The script is still run by hand. A later change adds a tool and a CI job.

## Consequences

### Positive

- Another repository gets the same check by copying the three script files and the Stryker config,
  and by adding the dev dependencies `@stryker-mutator/core`, `@stryker-mutator/vitest-runner` (or
  the runner it uses), `@stryker-mutator/instrumenter`, and `@stryker-mutator/util`.
- A survivor cannot pass unnoticed in `changed` mode.
- A tool or CI job can read the exit code and the JSON report.

### Negative

- Each repository keeps its own copy of the script, so copies can drift.
- A true equivalent change needs a disable comment with a reason.
- A test that related mode does not pick can leave a mutant as a survivor, although the test would
  kill it. The reader then reads the survivor and may run that test by hand.

## Alternatives considered

### Mutate the whole repository

Rejected because the run takes too long to repeat, and it reports survivors in code the change did
not touch.

### Run all unit tests in every run

Rejected because the dry run of all unit tests hit Stryker's 5 minute limit on a loaded machine and
failed with no result.
