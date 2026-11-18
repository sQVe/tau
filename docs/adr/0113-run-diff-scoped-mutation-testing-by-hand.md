# ADR 0113: Mutation-test changed lines and list survivors as advice

**Date**: 2026-10-19\
**Status**: Accepted\
**Supersedes**: [ADR 0115 (Copy the mutation script into each repository and fail on survivors)](./README.md#retired),
[ADR 0116 (Name the mutation command in the repository file)](./README.md#retired),
[ADR 0117 (List mutation survivors as advice instead of a gate)](./README.md#retired),
[ADR 0118 (List equivalent mutants instead of adding disable comments)](./README.md#retired)\
**Related**: [ADR 0105 (Queue full checks per checkout and reuse checks by identity)](./0105-queue-full-checks-per-repository-and-reuse-passing-logs.md),
[ADR 0119 (Share the mutation script as one npm package)](./0119-share-the-mutation-script-as-one-npm-package.md),
mergit ADR 0023 and koja ADR 0017, which make the same choice

## Context

`run_tests` shows that a test failed and then passed. It does not show that the test pins the
behavior. A mutation tool changes the code and reports each change that no test notices.

[Shared ADR 0009](../stomme/shared/adr/0009-advisory-review-signals.md) decides why a run checks
only the changed lines, why survivors are advice, and why code gets no disable comments.

## Decision

Mutation testing follows [shared ADR 0009](../stomme/shared/adr/0009-advisory-review-signals.md): it
checks only the production lines that a change touches, and each survivor is advice. Survivors never
fail a check, a skill step, or a merge.

### The run

- Tau's Stryker config names its mutated files, excluded modules, timeouts, and test runner. It
  turns on Vitest related-test mode, so Stryker runs only the tests that relate to the mutated
  files.
- In `changed` mode the script exits 2 to mark survivors. Exit 2 is advice, not a failure: every
  caller, including CI, accepts it. In `audit` mode it exits 0 with survivors. It exits 1 when any
  file stays unmutated, so a skipped file never looks like a pass.

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
- The tool counts covered and no-coverage survivors apart, and groups each set by file and line.
- A passing run is saved for reuse, including a run with survivors. A later call with the same
  arguments and file content returns the saved report and lists the same survivors. A failing run is
  never saved.

### Survivors

- After the affected tests pass, the `tdd` skill runs `mutation_check` once in `changed` mode, with
  the `base` its task names, or no `base`. A repository without `mutation.argv` skips this step.
- A worker on an agent ticket of a slice skips that step and says so. With no `base`, the tool
  mutates the whole diff since `origin/HEAD`, so each worker would also mutate the work of the
  workers before it. Instead, the `start-slice` skill runs `mutation_check` once after the last
  worker and before code-quality. It passes the merge base of the slice base and `HEAD`, so a
  stacked slice mutates only its own diff over the parent branch.
- In a slice, one worker fixes at most three behaviors in one round, then reruns the affected tests
  and the tool once. The manager lists the survivors left open for the pull request.
- A fix ticket from the slice audit runs after that check, so its worker runs the `tdd` step with
  the commit before the ticket as `base`.
- The `tdd` skill then fixes at most three behaviors in one round. A fix is a test that kills a
  survivor, or a simplification of redundant code that a survivor points at. The affected tests and
  the tool then run at most once more.
- The `tdd` skill lists the survivors left open, with file and line. It gives no reason for each
  mutant.
- For each survivor, follow [shared ADR 0009](../stomme/shared/adr/0009-advisory-review-signals.md):
  a test that kills it joins the owner's behavior test file or decision table, a wording or layout
  survivor gets no test, and an equivalent mutant stays open without a disable comment.
- The `pr` skill does not run `mutation_check` and does not report survivors.
- The `Mutation` CI job runs on pull requests in `changed` mode. It accepts exit codes 0 and 2,
  writes each survivor to the job summary, and fails on any other exit code, a status other than
  `pass`, `nothing`, or `survivors`, or a report without a `survivors` array. It does not check the
  fields of each survivor. It is not a required status check.

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

[Shared ADR 0009](../stomme/shared/adr/0009-advisory-review-signals.md) rejects mutating the whole
repository, making survivors a gate, and disabling equivalent mutants with comments.

### Run the check in the `pr` skill

Rejected because the `tdd` skill or the `start-slice` skill already runs it while the agent has the
change in context. A second run adds a step without new advice.

### Run the check after every worker of a slice

Rejected because each run mutates the work of the earlier workers again. One slice with several
agent tickets ran the check 13 times, and one run took 16 minutes.

### Name the command in the user file

Rejected because every user would copy a command that the repository already knows, and it would
drift from the script.

### Keep a copy of the script in each repository

Rejected because the copies drifted apart, and each repository fixed the same problems on its own.
