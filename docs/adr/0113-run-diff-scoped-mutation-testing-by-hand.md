# ADR 0113: Mutation-test changed lines and list survivors as advice

**Date**: 2026-10-19\
**Status**: Accepted\
**Supersedes**: [ADR 0115 (Copy the mutation script into each repository and fail on survivors)](./README.md#retired),
[ADR 0116 (Name the mutation command in the repository file)](./README.md#retired),
[ADR 0117 (List mutation survivors as advice instead of a gate)](./README.md#retired),
[ADR 0118 (List equivalent mutants instead of adding disable comments)](./README.md#retired)\
**Related**: [ADR 0105 (Queue full checks per repository and reuse passing logs)](./0105-queue-full-checks-per-repository-and-reuse-passing-logs.md),
[ADR 0119 (Share the mutation script as one npm package)](./0119-share-the-mutation-script-as-one-npm-package.md),
mergit ADR 0023 and koja ADR 0017, which make the same choice

## Context

`run_tests` shows that a test failed and then passed. It does not show that the test pins the
behavior. A mutation tool changes the code and reports each change that no test notices.

A full mutation run takes too long to repeat, and most mutants sit in code that a change did not
touch. Some survivors are equivalent changes that no test can catch.

A survivor that blocks publication turns mutation testing into one more step to clear before a
change can ship. Disable comments then became the easy way to clear a survivor. One pull request in
phi added a large batch of them, and many hid real test gaps.

## Decision

Mutation testing checks only the production lines that a change touches, and each survivor is
advice. Survivors never fail a check, a skill step, or a merge. No repository adds `Stryker disable`
comments.

### The run

- In `changed` mode, the script runs StrykerJS on the lines that `git diff -U0 <base>` adds, and on
  every line of each untracked file. `audit` mode mutates whole files.
- Each repository's Stryker config names its own mutated files, excluded modules, timeouts, and test
  runner. Tau's config turns on Vitest related-test mode, so Stryker runs only the tests that relate
  to the mutated files.
- In `changed` mode the script exits 2 when mutants survive. In `audit` mode it exits 0 with
  survivors. It exits 1 when any file stays unmutated, so a skipped file never looks like a pass.

### The command and reuse

- Every repository installs the shared npm package `@sqve/mutation` as a pinned dev dependency. The
  package holds the diff scope, the run, and the JSON report that `mutation_check` reads. No
  repository keeps a copy of the script.
- `mutation.argv` in the repository's `.pi/tau.json` names the package command. The command and the
  pinned version change in one commit. The user file may not set it, and Pi's project trust gates
  the key.
- The `mutation_check` tool lives in the `fullCheck` extension and shares its lock. A full check and
  a mutation check of one repository never run at once.
- `mutation_check` fails a run that stops, reports an error, or leaves a file unmutated.
- A passing run is saved for reuse, including a run with survivors. A later call with the same
  arguments and file content returns the saved report and lists the same survivors. A failing run is
  never saved.

### Survivors

- After the affected tests pass, the `tdd` skill runs `mutation_check` once in `changed` mode, with
  no `base`. A repository without `mutation.argv` skips this step.
- The `tdd` skill then fixes at most three behaviors in one round. A fix is a test that kills a
  survivor, or a simplification of redundant code that a survivor points at. The affected tests and
  the tool then run at most once more.
- The `tdd` skill lists the survivors left open, with file and line. It gives no reason for each
  mutant.
- A test that kills a survivor joins the owner's existing behavior test file, or adds a row to its
  decision table. No test file is named after a campaign or a test technique.
- A survivor in wording, layout text, or transport encoding that no caller can observe gets no test.
  It goes on the open list and does not count toward the three behaviors.
- An equivalent mutant stays on the open list. Code gets no `Stryker disable` comment. The script
  and Stryker still honor comments that already exist.
- The `pr` skill does not run `mutation_check` and does not report survivors.
- The `Mutation` CI job runs on pull requests in `changed` mode. It accepts exit codes 0 and 2,
  writes each survivor to the job summary, and fails on any other exit code or a malformed report.
  It is not a required status check.

## Consequences

### Positive

- A reviewer can see untested behavior in a change in the CI job summary.
- A change ships without waiting for every survivor, and reviewers can still ask for a test.
- A fix to the script reaches every repository through a version bump.
- Production code carries no tool markers.

### Negative

- A survivor can reach the main branch with no test that kills it.
- An equivalent mutant shows up in every run until the code changes, and nothing records why it is
  equivalent.
- A trusted repository decides which command runs.
- A script change needs a package release before a repository can use it.

## Alternatives considered

### Mutate the whole repository

Rejected because the run takes too long to repeat, and it reports survivors in code that the change
did not touch.

### Survivors as a gate

Rejected because it adds a step to every pull request for a check whose purpose is to improve tests.

### Run the check in the `pr` skill

Rejected because the `tdd` skill already runs it while the agent has the change in context. A second
run adds a step without new advice.

### Disable comments for equivalent mutants

Rejected because agents wrote them for real test gaps, and nobody rechecks a comment's reason.

### Name the command in the user file

Rejected because every user would copy a command that the repository already knows, and it would
drift from the script.

### Keep a copy of the script in each repository

Rejected because the copies drifted apart, and each repository fixed the same problems on its own.
