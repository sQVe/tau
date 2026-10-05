# ADR 0022: Gate the clamped read hint on the remainder

**Date**: 2026-09-13\
**Status**: Superseded\
**Superseded by**:
[ADR 0087 (Gather evidence with codemode)](./0087-gather-evidence-with-codemode.md)\
**Related**: [ADR 0014 (Delegate model for bulk reads)](./0014-delegate-model-for-bulk-reads.md)

## Context

[ADR 0014](./0014-delegate-model-for-bulk-reads.md) clamps unbounded reads to 400 lines and rewrites
Pi's continuation notice into a hint that names `bulk_read`. The hint does not say how much of the
file remains. The model cannot tell whether a delegate call, which takes about 30 seconds, or a
short bounded read is the cheaper next step, so small remainders get a delegate call.

Pi's notice already carries the remaining line count, in both its line-count form and its 50KB
"Showing lines" form. The hook reads only that text, because Pi sets no truncation flag on the
clamped path and ADR 0014 rejected a second file read.

## Decision

The rewritten hint states the remaining line range and names `bulk_read` only when more than 400
lines remain. Computing the remaining range from the notice and gating the `bulk_read` sentence on
the clamp threshold uses information Pi already gives, with no extra read.

### Hint rules

- Above the threshold, the hint suggests `bulk_read` for questions and a bounded read with `offset`
  and `limit` for edits.
- At or below the threshold, the hint suggests a bounded read with `offset` and `limit` and does not
  name `bulk_read`.
- The gate reuses the clamp threshold from ADR 0014. The two do not drift apart.
- The hook still matches the notice text and accepts the edge cases ADR 0014 lists.

This replaces the second bullet under "Clamping reads" in ADR 0014. The rest of that ADR stands.

## Consequences

### Positive

- The model sees the exact remainder and can choose the cheaper continuation.
- Small remainders avoid a delegate call.

### Negative

- The hint depends on the exact text of Pi's notice. A change to that text in Pi disables the
  rewrite until the pattern is updated.
- A 400-line file with a trailing newline now gets a hint to read one empty line, which is a more
  precise version of the edge case ADR 0014 accepts.

## Alternatives considered

### Fixed hint

Keep the fixed hint. Rejected because every clamped read still points at `bulk_read`, and small
remainders keep paying the delegate cost.

### Delegate picks the ranges

Have the delegate pick the ranges to return. Deferred because this is a separate excerpt experiment
and is out of scope here.
