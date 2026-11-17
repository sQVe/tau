# ADR 0121: Test architecture rules for placement, naming, fakes, and fixtures

**Date**: 2026-10-21\
**Status**: Accepted\
**Related**: [ADR 0005 (Integration testing against a real Pi session)](./0005-integration-testing-with-pi.md),
[ADR 0120 (Capability modules with an enforced import table)](./0120-capability-modules-with-an-enforced-import-table.md),
[ADR 0137 (Replay generated order failures as decision table rows)](./0137-replay-generated-order-failures-as-decision-table-rows.md)

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

Tau follows [shared ADR 0007](../stomme/shared/adr/0007-test-placement-and-fakes.md) for test
placement, names, decision tables, fakes, and fixture locations. It follows
[shared ADR 0009](../stomme/shared/adr/0009-advisory-review-signals.md) for size as a review signal.

Tau narrows the shared rules:

- `tests/` stays flat: `*Fake.ts` and `*Harness.ts` for support, and `*.integration.test.ts` for Pi
  or hc runs. Existing support files with other names move in later cleanup work, so this rule
  applies to new and moved files.
- Pi sessions and real `hc` run only in `tests/*.integration.test.ts`. This sets where the
  integration tests of ADR 0005 live.
- Split a test file over 1,000 lines in the pull request that splits its owner.

## Consequences

### Positive

- A reader finds the test for a module beside it, and finds shared support in one flat directory.
- A behavior change breaks the tests of one module instead of its callers.
- Shared fakes replace private copies of the same boundary.

### Negative

- Existing files that break a rule stay until cleanup work moves them.
- The size signal depends on review, because no check counts lines.

## Alternatives considered

### A nested `tests/` tree

Group support files in subdirectories of `tests/` by feature. Rejected because a flat directory with
suffixes gives the same grouping, and agents place files in a flat directory more reliably.

### No written rule

Keep the current practice and let reviewers correct files one by one. Rejected because agents copy
nearby files, so each unwritten pattern spreads.
