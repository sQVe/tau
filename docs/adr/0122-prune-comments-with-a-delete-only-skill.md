# ADR 0122: Prune comments with a delete-only skill

**Date**: 2026-10-22\
**Status**: Accepted\
**Related**: [ADR 0024 (Commit through Git hooks, without approval or Tau checks)](./0024-commit-without-human-approval.md)

## Context

Agents add comments that restate names, types, and tests. The coding instructions already say to
comment only what the code cannot say, but nothing enforces the rule after the code is written.
[ADR 0024 (Commit through Git hooks, without approval or Tau checks)](./0024-commit-without-human-approval.md)
removed the commit gate that judged comments, because a model can always find a new objection to
wording and the gate blocked passing commits.

## Decision

Add a `/prune-comments` skill that deletes comments and does nothing else. A fresh worker judges
each comment against one keep test: keep it only when it names the concrete wrong change a reader
would make without it, which names, types, and tests do not already prevent. Doc comments follow the
same test. Tool directives, license headers, generated files, and text the program reads at runtime,
such as Python docstrings, are never judged, because deleting runtime text changes behavior.

The skill runs on request, not at commit time, so it blocks no commit. It never rewords or adds a
comment, so a finding cannot draw a new objection to new text. A diff target judges only the
comments the diff adds or changes, so it leaves older comments alone. On the user's own work it
deletes in one commit and lists each removal, because a deleted comment is easy to restore from Git.
On other work it asks first.

## Consequences

### Positive

- Comments that restate the code leave a branch before review.
- A delete-only action has no retry loop and no wording dispute.

### Negative

- A model can delete a comment that a reader needed. The list of removals and the single commit make
  that easy to find and revert.
- The worker finds comments by syntax, so it can miss an unusual comment form.

## Alternatives considered

### Restore a commit-time gate

Judge comments again when the `commit` tool runs. Rejected because
[ADR 0024 (Commit through Git hooks, without approval or Tau checks)](./0024-commit-without-human-approval.md)
showed that such a gate blocks passing commits.

### Reword weak comments

Let the worker rewrite a comment instead of deleting it. Rejected because new text brings new claims
that need review, and the keep test already says when a comment is worth having.

### Lint rule

Detect restating comments with a lint plugin. Rejected because the keep test needs judgment, and the
skill must work in any repository.
