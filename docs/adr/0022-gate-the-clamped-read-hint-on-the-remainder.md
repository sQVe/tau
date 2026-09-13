# ADR 0022: Gate the clamped read hint on the remainder

- Status: Proposed
- Date: 2026-09-13

## Context

[ADR 0014](./0014-delegate-model-for-bulk-reads.md) clamps unbounded reads to 400 lines and rewrites
Pi's continuation notice into a hint that names `bulk_read`. The hint does not say how much of the
file remains. The model cannot tell whether a delegate call, which takes about 30 seconds, or a
short bounded read is the cheaper next step, so small remainders get a delegate call.

Pi's notice already carries the remaining line count, in both its line-count form and its 50KB
"Showing lines" form. The hook reads only that text, because Pi sets no truncation flag on the
clamped path and ADR 0014 rejected a second file read.

## Options considered

- Keep the fixed hint. Every clamped read still points at `bulk_read`, and small remainders keep
  paying the delegate cost. Rejected.
- Have the delegate pick the ranges to return. This is the excerpt experiment tracked in ABU-375 and
  is out of scope here.
- Compute the remaining range from the notice and gate the `bulk_read` sentence on the clamp
  threshold. Uses information Pi already gives, with no extra read. Chosen.

## Decision

The rewritten hint states the remaining line range and names `bulk_read` only when more than 400
lines remain.

- Above the threshold, the hint suggests `bulk_read` for questions and a bounded read with `offset`
  and `limit` for edits.
- At or below the threshold, the hint suggests a bounded read with `offset` and `limit` and does not
  name `bulk_read`.
- The gate reuses the clamp threshold from ADR 0014. The two do not drift apart.
- The hook still matches the notice text and accepts the edge cases ADR 0014 lists.

This replaces the second bullet under "Clamping reads" in ADR 0014. The rest of that ADR stands.

## Tradeoffs

- The model sees the exact remainder and can choose the cheaper continuation.
- Small remainders avoid a delegate call.
- Cost: the hint depends on the exact text of Pi's notice. A change to that text in Pi disables the
  rewrite until the pattern is updated.
- Cost: a 400-line file with a trailing newline now gets a hint to read one empty line, which is a
  more precise version of the edge case ADR 0014 accepts.

## See also

- [ADR 0014: Delegate model for bulk reads](./0014-delegate-model-for-bulk-reads.md)
