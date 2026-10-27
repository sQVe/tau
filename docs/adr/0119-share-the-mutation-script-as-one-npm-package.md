# ADR 0119: Share the mutation script as one npm package

**Date**: 2026-10-19\
**Status**: Accepted\
**Supersedes**: [ADR 0115 (Copy the mutation script into each repository and fail on survivors)](./README.md#retired):
the copy of the script in each repository\
**Related**: [ADR 0113 (Mutation-test changed lines and list survivors as advice)](./0113-run-diff-scoped-mutation-testing-by-hand.md)

## Context

ADR 0115 had each repository copy Tau's mutation script and adapt it by hand. Three repositories now
run it: Tau with the Vitest runner, and two Bun projects. Within days the copies drifted. One Bun
copy changed 170 lines of the main script file. Both Bun projects solved the same runner problems on
their own, and a fix in one copy did not reach the others.

What a repository needs to choose is small: which files to mutate, which modules to leave out,
timeouts, and the test runner. The rest of the script, such as scope parsing, the report, and the
ignorer, is the same in every repository.

## Decision

Every repository runs mutation testing through one npm package, `@sqve/mutation`, kept in the
`sQVe/mutation` repository and installed as a pinned dev dependency. No repository keeps a copy of
the script.

The package owns the shared parts, so a fix ships once to every repository:

- the diff scope, the run, and the JSON report that `mutation_check` reads;
- the `tauMessageIgnorer` plugin, which the command always adds to the Stryker config, and
  `ignoreStatic: true`, which it sets unless the repository sets its own value;
- support for the Vitest and Bun runners, with same-folder test selection behind the
  `--same-folder-tests` switch.

Each repository's Stryker config holds only its own policy: the `mutate` globs, the modules it
leaves out, timeouts, and the runner. `mutation.argv` in `.pi/tau.json` names the package's
`mutation` command. The command has no mutant cap by default, so a change of any size runs every
mutant on its changed lines; a CI job bounds its time with `timeout-minutes`.

The pinned version keeps the reason of ADR 0113: the command and the pinned version change in one
commit.

## Consequences

### Positive

- A fix or new runner support reaches every repository through a version bump.
- A repository's Stryker config shows only what is particular to it.
- The package has one test suite for both runners and both settings of the same-folder switch.

### Negative

- A change to the script needs a package release before a repository can use it.
- A repository cannot patch the script locally; it must change the package or wait for a release.

## Alternatives considered

### Keep a copy in each repository

The rule of ADR 0115. Rejected because the copies drifted within days and each repository fixed the
same problems on its own.

### Ship the script inside Tau's package

Projects would install Tau to get the command. Rejected because Tau is a Pi package, and a project
that only wants mutation testing would install Pi extensions and their dependencies with it.
