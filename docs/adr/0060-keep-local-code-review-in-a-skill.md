# ADR 0060: Keep local code review in a skill

- Status: Accepted; the rule "Add no review tools or review state" superseded by
  [ADR 0089](./0089-capture-review-targets-with-a-code-review-tool.md)
- Date: 2026-09-28

## Context

A prototype review engine added review tools, target snapshots, candidate registration, and verdicts
bound to fresh verifier tasks. With tests, it grew to about 3,000 lines. In a trial, handoffs and
verification took almost half the review time. The tools proved which task saved a verdict, not
whether the verdict was right.

## Options considered

- Keep the dedicated engine. Rejected: it gives mechanical provenance for each verdict, but its
  orchestration cost falls on every review and it cannot prove a verdict true.
- Keep review in a skill that uses the existing worker tools. Chosen: review judgment stays
  advisory, and no review-specific state needs maintenance.

## Decision

Keep local code review in the `code-review` skill with a `/code-review` alias. Add no review tools
or review state.

- Fast review uses one fresh reviewer that checks its own findings.
- Deep review adds one fresh checker after one finder. The checker tests each candidate and looks
  for omissions.
- Findings carry their evidence status as advice, not as mechanical proof.

## Tradeoffs

- The parent coordinates fewer steps, and Tau maintains no review tools or state.
- Cost: fast findings are not independently checked.
- Cost: nothing enforces that a deep verdict came from a fresh checker.
