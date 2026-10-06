# ADR 0035: Use size thresholds as review guidance

**Date**: 2026-09-21\
**Status**: Accepted\
**Supersedes**: The size limits in
[ADR 0034 (Check house style outside the editor)](./0034-check-house-style-outside-the-editor.md)

## Context

A readability refactor split one worker controller into an inheritance chain that still shared
lifecycle state. Smaller files did not remove that coupling, and the split introduced a regression.
Line and parameter counts find code worth reviewing, but they cannot tell whether a split makes
behavior easier to trace. Tau rejects lint warnings in required checks, so turning these rules into
warnings would still block changes.

## Decision

Use function length, file length, and parameter count as review guidance, not lint gates. Keeping
size thresholds in coding guidance without lint gates requires judgment but lets coupled control
flow stay together. Keep 60 lines per function, 500 lines per file, and 4 parameters as prompts to
review a boundary.

Extract code when the new boundary makes a behavior easier to understand. Do not introduce
inheritance or parameter objects only to satisfy those thresholds. Keep the other house-style checks
from ADR 0034, including condition checks.

## Consequences

### Positive

- Related state transitions can stay together even when their controller exceeds a size threshold.

### Negative

- Reviewers must judge boundaries rather than rely on line counts.
- Removing size gates does not prove that the remaining structure is readable.

## Alternatives considered

### Mandatory size limits

Keep mandatory size limits. Rejected because, although this bounds local size, it can encourage
artificial boundaries.
