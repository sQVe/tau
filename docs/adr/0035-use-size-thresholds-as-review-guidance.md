# ADR 0035: Use size thresholds as review guidance

- Status: Accepted
- Date: 2026-09-21
- Supersedes: The size limits in [ADR 0034](./0034-check-house-style-outside-the-editor.md)

## Context

The readability refactor split one worker controller into an inheritance chain while retaining
shared lifecycle state. Smaller files did not remove that coupling. The split also introduced a
polling-budget regression, fixed separately with a regression test.

Line and parameter counts identify code worth reviewing, but cannot tell whether a split makes
behavior easier to trace. Tau rejects lint warnings in required checks, so changing these rules from
errors to warnings would still block changes.

## Options considered

- Keep mandatory size limits. This bounds local size but can encourage artificial boundaries.
- Keep size thresholds in coding guidance without lint gates. This requires judgment but allows
  coupled control flow to stay together.

## Decision

Use function length, file length, and parameter count as review guidance, not lint gates. Keep 60
lines per function, 500 lines per file, and 4 parameters as prompts to review a boundary.

Extract code when the new boundary makes a behavior easier to understand. Do not introduce
inheritance or parameter objects only to satisfy those thresholds. Keep the other house-style checks
from ADR 0034, including condition checks.

## Tradeoffs

- Related state transitions can stay together even when their controller exceeds a size threshold.
- Cost: reviewers must judge boundaries rather than rely on line counts.
- Cost: removing size gates does not prove that the remaining structure is readable.
