# ADR 0013: Fix before commit staging

- Status: Proposed
- Date: 2026-09-10

## Context

Formatting hooks can rewrite approved content. The commit tool then undoes the commit, requiring
another check, review, and approval. AI-163 requires fixes before staging without weakening checks
or the post-commit guards.

## Options considered

- Keep fixing in hooks. Preserves the undo-and-retry cycle.
- Infer formatting commands from each repository's hooks. Requires support for many hook formats and
  risks running unrelated hook actions early.
- Use an optional root `scripts.fix`. Gives each repository one explicit command for local fixes.

## Decision

Use root `scripts.fix` before staging, including temporary staging for batch review planning.
Resolve its package manager with the same rules as `scripts.check`. Read the working manifest
because fixes must happen before a candidate is staged. Run once per call, before any group
approval, so later fixes do not invalidate earlier batch reviews.

Keep candidate checks and approval unchanged. Tau's own staged hook checks lint and formatting
without fixing. Do not alter hooks in other repositories or remove the post-commit guards.

## Tradeoffs

- The approved tree includes local fixes without a second commit call.
- Repositories without a fixer still get candidate checks.
- A failing fixer stops before staging and reports its output.
- A repository-wide fixer can change unrequested working files. Those changes stay outside the
  commit unless requested.
- Fixers must be safe to rerun; the tool does not undo their working changes.
