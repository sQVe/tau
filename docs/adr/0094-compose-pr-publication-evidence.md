# ADR 0094: Compose PR publication evidence

**Date**: 2026-10-06\
**Status**: Accepted\
**Related**: [ADR 0089 (Review code in a skill with a code_review tool)](./0089-capture-review-targets-with-a-code-review-tool.md)

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

The full check has one identity, the saved record that `full_check` writes next to its log in
`.tau/checks` (see [ADR 0105](./0105-queue-full-checks-per-repository-and-reuse-passing-logs.md)).
The action reads the newest record for the tree ID of the working state, and returns `fullCheck` as
passed, failed, missing, or malformed. It reads the configured full check command and reports
`missing` when no command is configured or the record ran another one. Failed, missing, and
malformed records become gaps. Other checks carry the header identity that
[ADR 0105](./0105-queue-full-checks-per-repository-and-reuse-passing-logs.md) defines.

For each check file name, the log with the latest modification time counts, and a tie goes to the
greater path. Logs whose modification time cannot be read also count. Older runs are history, not
missing publication evidence. A changed identity prevents reuse but is not a gap. Unreadable logs,
missing or malformed headers, and an unavailable current identity remain gaps. Modification times
select which log to consider; content identities still decide whether that log can be reused.

A matching identity means the log belongs to those inputs, not that its check passed. The action
returns bounded tails from matching logs and reports any cut. The skill keeps the publication
judgment.

## Consequences

### Positive

- Publication uses the same target and review rules as their individual actions.
- A caller receives missing, failed, and stale evidence together instead of inferring completeness.
- Check log matching does not depend on clocks or file modification times.

### Negative

- The result is not an atomic snapshot. Git or files can change between reads.

## Alternatives considered

### Gather each result in the skill

Keep orchestration and log matching in the skill. Rejected because every publication run would need
to repeat the same mechanics and failure handling.

### Reimplement the readers for publication

Use one publication-specific Git and review reader. Rejected because separate implementations can
assign different meanings to the same saved review.
