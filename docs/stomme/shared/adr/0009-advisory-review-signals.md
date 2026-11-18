# ADR 0009: Advisory mutation testing and size as a review signal

**Date**: 2026-11-15\
**Status**: Accepted

## Context

A test that fails and then passes does not show that it pins the behavior. A mutation tool changes
the code in small ways and reports each change that no test fails, called a survivor.

A full mutation run takes too long to repeat, and most mutants sit in code that a change did not
touch. Some survivors are equivalent changes that no test can catch.

A survivor that blocks a merge turns mutation testing into one more step to clear. Disable comments
then become the easy way to clear a survivor, and they hide real test gaps.

Size limits have the same problem. A hard line limit does not show ownership. It forces splits of
cohesive files, while a file under the limit can still hold every feature.

## Decision

Mutation testing checks the production lines a change touches, and each survivor is advice. Size
limits are review signals. Neither fails a check, a merge, or a review step on its own.

### Mutation runs

- Each repository has one mutation command with two modes. Changed mode mutates the lines changed
  since a base ref and every line of untracked files. Audit mode mutates whole files.
- Both modes print one JSON report, so a local agent and CI read the same result.
- Rust projects use cargo-mutants and TypeScript projects use StrykerJS. Each repository's tool
  config names its own mutated files and test runner.
- Test code and test helpers are not mutated, because mutating them only weakens the tests.
- Survivors never fail the command. An error, a failing baseline, or a file left unmutated does, so
  a skipped file never looks like a pass.
- CI runs changed mode on every pull request, against the pull request's base commit. The job lists
  survivors in its summary and is not a required check.

### Survivors

- The author decides for each survivor: add a test that fails when that line changes, simplify the
  redundant code it points at, or leave it open.
- A test that kills a survivor joins the owner's existing test file, or adds a row to its decision
  table.
- A survivor in wording or layout text that no caller can observe gets no test.
- Code gets no disable comments. An equivalent mutant stays on the open list.

### Size

- Review a file over 500 lines, a function over 60 lines, a function with more than four parameters,
  and a test file over 1,000 lines.
- Split by responsibility, not to meet a count. Do not split an exhaustive match only to meet a
  limit.
- No check fails on these limits.

## Consequences

### Positive

- A reviewer can see untested behavior in a change in the CI job summary.
- A change ships without waiting for every survivor, and reviewers can still ask for a test.
- Production code carries no tool markers.
- Cohesive files stay whole, and size still prompts a review.

### Negative

- A survivor can reach the main branch with no test that kills it.
- An equivalent mutant shows up in every run until the code changes, and nothing records why it is
  equivalent.
- Without a failing check, the size signals depend on review and can drift.

## Alternatives considered

### Mutate the whole repository on every change

Rejected because the run takes too long to repeat, and it reports survivors in code that the change
did not touch.

### Survivors as a gate

Block a merge on any survivor. Rejected because some survivors are equivalent mutants, and blocking
on them pushes authors to suppress mutants in production code.

### Disable comments for equivalent mutants

Mark equivalent mutants with comments in the code. Rejected because agents write them for real test
gaps, and nobody rechecks a comment's reason.

### A hard line limit in the check

Make the check refuse files over 500 lines. Rejected because a count does not show ownership, and it
forces splits of cohesive files.
