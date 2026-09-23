# ADR 0038: Block commits only on verified comment inaccuracies

- Status: Proposed
- Date: 2026-09-23
- Amends: the blocking rule in [ADR 0026](./0026-let-git-hooks-own-commit-checks.md)

## Context

Comment review sorts findings into inaccurate, policy, and missing. A verifier checks inaccurate
findings against the code before they block. Policy findings, such as narration of obvious code,
blocked without a check.

Policy findings are style judgments, and the review model makes them differently on each run. Each
corrected tree got a fresh review, which raised a new policy finding on code the previous run had
passed. It flagged test titles and tool description fields as comments. After two returns the gate
refused the commit, and the agent handed a passing, reviewed change back to the user.

## Options considered

- Keep policy findings blocking. Retries keep producing new findings on unchanged code, and the user
  has to step in over style.
- Review only lines that changed since the previous review. This stops repeat findings on passed
  code but still blocks on unverified judgments, and it needs state across trees.
- Verify policy findings like inaccuracies. The verifier sees only an excerpt and not the project
  conventions a policy finding may rest on, so it cannot settle them.
- Report policy findings as advisory. Commits proceed, and the agent still sees the findings.

## Decision

Only verified inaccurate findings block a commit. Policy, missing, and unverified findings are
advisory and appear in the commit report. The return limit and refusal rules from ADR 0026 still
apply to blocking findings.

## Tradeoffs

- A style opinion from a model no longer stops a commit or pulls in the user.
- Cost: narrating comments and leftover development notes can land in history. Code review and the
  advisory report remain the checks for them.
