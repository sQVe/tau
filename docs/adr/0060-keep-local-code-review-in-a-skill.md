# ADR 0060: Keep local code review in a skill

**Date**: 2026-09-28\
**Status**: Accepted; the rule "Add no review tools or review state" superseded by
[ADR 0089 (Capture review targets with a code_review tool)](./0089-capture-review-targets-with-a-code-review-tool.md)

## Context

A prototype review engine added review tools, target snapshots, candidate registration, and verdicts
bound to fresh verifier tasks. With tests, it grew to about 3,000 lines. In a trial, handoffs and
verification took almost half the review time. The tools proved which task saved a verdict, not
whether the verdict was right.

## Decision

Keep local code review in the `code-review` skill with a `/code-review` alias. Add no review tools
or review state. Keeping review in a skill that uses the existing worker tools keeps review judgment
advisory, and no review-specific state needs maintenance.

### Review modes

- Fast review uses one fresh reviewer that checks its own findings.
- Deep review adds one fresh checker after one finder. The checker tests each candidate and looks
  for omissions.
- Findings carry their evidence status as advice, not as mechanical proof.

## Consequences

### Positive

- The parent coordinates fewer steps, and Tau maintains no review tools or state.

### Negative

- Fast findings are not independently checked.
- Nothing enforces that a deep verdict came from a fresh checker.

## Alternatives considered

### Keep the dedicated engine

Keep the dedicated review engine. Rejected because, although it gives mechanical provenance for each
verdict, its orchestration cost falls on every review and it cannot prove a verdict true.
