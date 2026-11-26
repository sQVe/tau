# ADR 0011: A weakened-test ratchet against the target branch

**Date**: 2026-11-26\
**Status**: Accepted\
**Related**: [ADR 0010 (Recorded violations with a stale check and a growth gate)](./0010-recorded-violations.md)

## Context

A test suite protects a change only while its cases keep running. A change can weaken the suite in
three ways that still compile and still pass the other tests: it skips a test, it hides a finding
behind a lint or type-check suppression, or it deletes a case. None of those forms is visible in the
change's own test run, because the weakened case no longer runs or no longer exists.

A rule that reads only the current tree cannot tell a new skip from an old one. The comparison needs
a baseline outside the change, so the change cannot approve its own weakening.

## Decision

`stomme check` reports one rule, `weakened-test`, for a change that adds a test skip, adds a lint or
type-check suppression, or deletes a test case against the target branch.

The check compares the working tree with the resolved target ref, as [ADR
0010](./0010-recorded-violations.md) does for recorded violations. The implicit remote-tracking ref
stays strict, so a tag cannot stand in for the fetched branch. An explicit `--base` accepts any
revision expression. A missing target ref fails the check, because a skipped gate would let a change
pass unreviewed.

The check identifies a test case by its file and its name. A rename therefore counts as a deleted
case, while a move to another file does not. A deleted case is reported at the line that the target
branch declares.

Detection is bounded text matching on the added lines of the change and on the declarations in both
trees. It is not a parser for each test framework.

A repository with no commit reports nothing. A fresh project has no target branch yet, and a CI
checkout always has a commit, so the gate still runs where it can compare.

The problems carry no key. `[[violations]]` entries need a key, so a weakened test cannot be
recorded as current debt. The change must fix it.

## Consequences

### Positive

- A change cannot accept its own weakened test by editing a baseline in the same commit.
- One rule holds the three forms, so a project cannot keep one form enforced and another recorded.
- A rename is visible as a deleted case, and a move stays allowed.
- The text rules are small and need no test-framework dependency.

### Negative

- The check needs the target branch in the local Git repository, and CI must fetch it.
- Text matching misses forms that a real parser would see, such as a test name on another line.
- A local branch behind the target can report a target-only test as an apparent deletion.
- The check cannot record an accepted skip or suppression, so a project must fix the change.

## Alternatives considered

### One rule per language

A separate rule for Rust and for TypeScript would let a project configure one form at a time. This
was rejected because the three forms share one policy and one "cannot compare" outcome. Splitting
the rule would let a project weaken one language while the other stays enforced.

### Keyed `[[violations]]` exceptions

A key on each problem would let a project record an accepted skip, suppression, or deletion. This
was rejected because the recorded list exists for old debt that a project cannot fix yet. A new skip
or a deleted test is a choice in the current change, and a key would let the change approve it.

### A committed baseline snapshot

A snapshot file in the repository could list the current skips and cases. This was rejected because
the change can edit the snapshot in the same commit as the code it hides. Comparing with the target
branch removes that self-approval.

### A parser per test framework

A parser for each Rust attribute and TypeScript test helper could name cases more precisely. This
was rejected because it adds a dependency and a new parser for every framework, while the supported
text forms cover the common declarations. The guide names the forms that the check misses.
