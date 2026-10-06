# ADR 0094: Compose PR publication evidence

**Date**: 2026-10-06\
**Status**: Accepted\
**Related**: [ADR 0091 (Return review evidence from the code_review tool)](./0091-return-review-evidence-from-the-code-review-tool.md)

## Context

PR publication needs the branch target, saved review evidence, review reuse, and local check logs.
These facts can disagree. A review can cover the branch diff while its capture is stale, and a saved
check log can belong to an earlier head.

The target, reuse, and review evidence readers already own their Git and capture rules. A second
implementation would let publication interpret the same saved review differently from code review.

## Decision

Compose publication evidence in one `pr` action, and bind saved check logs to explicit content
identities rather than their timestamps.

The action calls the existing readers without replacing their results or rules. It reads reuse
before review evidence because freshness recapture can replace the saved diff that reuse compares.
Failures and missing evidence remain gaps; they do not hide independent evidence or become a
publication verdict. The action inherits the target reader's base fetch and the review reader's
freshness recapture. It writes no other worktree files.

Check logs carry three initial header lines: `HEAD: <sha>`, `Status: <hash>`, and `Diff: <hash>`.
Status and diff hashes use SHA-256 over the exact output bytes of `git status --porcelain` and
`git diff <mergeBase> HEAD`, including trailing newlines. A caller asks the `pr` tool's read-only
`checkHeader` action for the lines and records them before its check. Header production and evidence
matching share one identity reader, so byte handling and Git output limits cannot drift. Explicit
byte hashing avoids shell whitespace changes and works independently of Git's object format. A
missing or malformed header cannot establish a match.

Only the newest log for each check file name counts, selected by the file's modification time. Older
runs are history, not missing publication evidence. A changed identity prevents reuse but is not a
gap. Unreadable logs, missing or malformed headers, and an unavailable current identity remain gaps.
Modification times select which log to consider; content identities still decide whether that log
can be reused.

A matching identity means the log belongs to those inputs, not that its check passed. The action
returns bounded tails from matching logs and reports any cut. The skill keeps the publication
judgment.

## Consequences

### Positive

- Publication uses the same target and review rules as their individual actions.
- A caller receives missing, failed, and stale evidence together instead of inferring completeness.
- Check log matching does not depend on clocks or file modification times.

### Negative

- Callers must save the exact header before running a check to make its log reusable.
- The result is not an atomic snapshot. Git or files can change between reads.
- Porcelain status describes paths and states, not dirty file contents. Its hash cannot detect every
  edit to an already dirty file.

## Alternatives considered

### Gather each result in the skill

Keep orchestration and log matching in the skill. Rejected because every publication run would need
to repeat the same mechanics and failure handling.

### Reimplement the readers for publication

Use one publication-specific Git and review reader. Rejected because separate implementations can
assign different meanings to the same saved review.

### Compute headers in the skill

Give the skill scripts that hash Git output. Rejected because they duplicate the reader's mechanics
and can use different output limits, failing on diffs the evidence reader can handle.

### Match logs by head or timestamp only

Treat a recent log or an equal head as sufficient. Rejected because neither records worktree status
or the branch diff against the selected merge base.
