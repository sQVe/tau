# ADR 0117: List mutation survivors as advice instead of a gate

**Date**: 2026-10-18\
**Status**: Accepted\
**Supersedes**: [ADR 0115 (Copy the mutation script into each repository and fail on survivors)](./0115-copy-mutation-script-per-repository-and-fail-on-survivors.md):
use of survivors as a gate

## Context

ADR 0115 made a survivor on a changed line fail the check, so the `pr` skill stopped publication
until each survivor had a test, simpler code, or a disable comment. Mutation testing exists to find
weak tests. A stop at publication turns it into one more step to clear before a change can ship. The
user put it this way: "We want to use this to IMPROVE our tests, not add more hoops that we need to
jump through."

## Decision

Mutation testing is advice everywhere: survivors never fail a check, a skill step, or a merge.

The `mutation_check` tool passes a run with survivors, when the script exits 2 in changed mode or 0
in audit mode. It fails on an error report, unmutated files, a nonzero exit other than 2 with
survivors, a signal, and the idle stop. It saves a passing run with survivors for reuse, and a
reused run lists the same survivors from the saved report. It counts survivors that tests cover
apart from mutants with no coverage, and groups each set by file and line.

The `tdd` skill runs the tool once after the full check passes. It allows one fix round of at most 3
behaviors, a test that kills the survivor or a simplification of redundant code, and at most one
rerun of the full check and the tool. It then lists what is left as open, with file and line, and
gives no reason per mutant. The `pr` skill does not run the tool and does not report survivors.

A test that kills a survivor joins the owner's existing behavior test file, or adds a row to its
decision table. No test file is named after a campaign or a test technique, such as
`mutationKills.test.ts` or a slice name. A survivor in wording, layout text, or transport encoding
that no caller can observe gets no test. The `tdd` report lists it with the other open survivors,
with no reason, and it does not count toward the limit of 3 behaviors.

The `Mutation` CI job passes on exit 0 and exit 2 and fails on any other exit. It writes the
survivors to the job summary. It is not a required status check.

## Consequences

### Positive

- A change ships without waiting for every survivor to be resolved.
- The agent and the user see the survivors before publication and can add a test where one matters.
- The pull request body stays short.
- Killing tests stay in the owner's test file, so a reader finds all tests of a behavior in one
  place.

### Negative

- A survivor can reach the main branch with no test that kills it.
- A survivor appears only in the job summary, which a reviewer must open to see it.
- A survivor in text that no caller can observe stays open with no test.

## Alternatives considered

### Keep survivors as a stop before publication

Keep ADR 0115's rule in the `pr` skill. Rejected because it adds a step to every pull request for a
check whose purpose is to improve tests, and equivalent mutants still need a disable comment before
anything ships.

### List survivors in the pull request body

Show each survivor to reviewers in the verification section. Rejected because the user wants that
output out of pull requests, and a long survivor list crowds out the rest of the body.

### Keep the mutation check in the `pr` skill

Run the tool at publication and list survivors in the session report. Rejected because the `tdd`
skill already runs it while the agent has the change in context, and a second run at publication
adds a step without new advice. CI still shows survivors in the job summary.
