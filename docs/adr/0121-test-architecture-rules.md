# ADR 0121: Test architecture rules for placement, naming, fakes, and fixtures

**Date**: 2026-10-21\
**Status**: Accepted\
**Related**: [ADR 0005 (Integration testing against a real Pi session)](./0005-integration-testing-with-pi.md),
[ADR 0120 (Capability modules with an enforced import table)](./0120-capability-modules-with-an-enforced-import-table.md)

## Context

Agents write tests in parallel branches. Each branch adds the support it needs, so the same helper
appears in several places. Three problems follow.

- Git PATH wrappers and `gh` fakes are duplicated across features, because each feature owns a
  private copy of a boundary that several features use.
- Adapter tests repeat cases that the decision table of the same module already holds, so one
  behavior change breaks tests in two places.
- Some test files are named after a technique or a campaign, such as `toolLstat.test.ts`, so a
  reader cannot tell which module the file defends.

No written rule says where a test belongs, what to fake, or where a fixture lives. Agents copy the
nearest file, and the drift grows.

## Decision

Tau follows seven rules for tests. They add to the layers in ADR 0005. In this ADR, a module means a
capability module or an extension feature folder, as ADR 0120 uses the word.

1. A unit test sits beside its owner and is named `<owner>.test.ts` or `<owner><Behavior>.test.ts`.
   No file is named after a campaign or a test technique. `checkFakeGit.test.ts` and
   `toolLstat.test.ts` are bad names.
2. A decision table holds every case. The adapter test holds one case per outcome kind and its side
   effects. A shared module's behavior is tested once, in that module.
3. A test that kills a mutation survivor follows the placement rule in step 5 of
   [the TDD skill](../../src/skills/tdd/SKILL.md).
4. Fake the boundary, not the module: `Exec`, the herdr client, or a command shim. Assert outcomes.
   Read a `calls` list only when the call is the behavior.
5. A fixture used by one module lives in that module's `fixtures/`. A fixture used by two modules or
   by `tests/` lives in `tests/`. `tests/` stays flat: `*Fake.ts` and `*Harness.ts` for support, and
   `*.integration.test.ts` for Pi or herdr runs. Existing support files with other names move in
   later cleanup work, so this rule applies to new and moved files.
6. Size is a review signal. Split a test file over 1,000 lines in the pull request that splits its
   owner.
7. Pi sessions and real herdr run only in `tests/*.integration.test.ts`. This sets where the
   integration tests of ADR 0005 live.

Rules 1 and 5 give every file one home that a reader can predict. Rules 2 and 4 keep each behavior
under one test, so a change breaks one place.

## Consequences

### Positive

- A reader finds the test for a module beside it, and finds shared support in one flat directory.
- A behavior change breaks the tests of one module instead of its callers.
- Shared fakes replace private copies of the same boundary.

### Negative

- Existing files that break a rule stay until cleanup work moves them.
- Rule 6 depends on review, because no check counts lines.

## Alternatives considered

### A nested `tests/` tree

Group support files in subdirectories of `tests/` by feature. Rejected because a flat directory with
suffixes gives the same grouping, and agents place files in a flat directory more reliably.

### No written rule

Keep the current practice and let reviewers correct files one by one. Rejected because agents copy
nearby files, so each unwritten pattern spreads.
