# ADR 0038: Block commits only on comment inaccuracies

**Date**: 2026-09-23\
**Status**: Superseded\
**Superseded by**:
[ADR 0042 (Remove commit comment review)](./0042-remove-commit-comment-review.md)\
**Supersedes**: the blocking rule in
[ADR 0026 (Let Git hooks own commit checks)](./0026-let-git-hooks-own-commit-checks.md)

## Context

Comment review sorts findings into inaccurate, policy, and missing. A verifier checks inaccurate
findings against the code before they block. Policy findings, such as narration of obvious code,
blocked without a check.

Policy findings are style judgments, and the review model makes them differently on each run. Each
corrected tree got a fresh review, which raised a new policy finding on code the previous run had
passed. After two returns the gate refused the commit, and the agent handed a passing, reviewed
change back to the user.

## Decision

Only inaccurate findings block a commit, unless the verifier rejects them. Reporting policy findings
as advisory lets commits proceed, and the agent still sees the findings. Policy, missing, and
unverified findings are advisory and appear in the commit report. The return limit and refusal rules
from [ADR 0026](./0026-let-git-hooks-own-commit-checks.md) still apply to blocking findings.

## Consequences

### Positive

- A style opinion from a model no longer stops a commit or pulls in the user.

### Negative

- Narrating comments and leftover development notes can land in history. Code review and the
  advisory report remain the checks for them.

## Alternatives considered

### Keep policy findings blocking

Keep policy findings blocking. Rejected because retries keep producing new findings on unchanged
code, and the user has to step in over style.

### Review only changed lines

Review only lines that changed since the previous review. Rejected because, although this stops
repeat findings on passed code, it still blocks on unverified judgments, and it needs state across
trees.

### Verify policy findings like inaccuracies

Verify policy findings like inaccuracies. Rejected because the verifier sees only an excerpt, not
the project conventions a policy finding may rest on, so it cannot settle them.
