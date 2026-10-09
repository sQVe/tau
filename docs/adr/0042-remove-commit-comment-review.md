# ADR 0042: Remove commit comment review

**Date**: 2026-09-24\
**Status**: Accepted\
**Supersedes**: [ADR 0038 (Block commits only on comment inaccuracies)](./0038-block-commits-only-on-comment-inaccuracies.md)
and the review rules in
[ADR 0026 (Let Git hooks own commit checks)](./0026-let-git-hooks-own-commit-checks.md)

## Context

The `commit` tool sent each staged tree to a model that reviewed its comments before Git hooks ran.
Blocking findings returned tool errors, and a group was refused after two returns.

The gate blocked checked, passing commits over comment wording, not over code. Each fix to a flagged
comment could draw a new objection, and the user had to step in. Pi session logs show 180 refusals
after two returns against about 93 successful commit groups. The gate was already patched four
times, including [ADR 0038](./0038-block-commits-only-on-comment-inaccuracies.md)'s advisory policy
findings. It still blocked on judgment calls, because a model can always find a new objection to a
comment.

## Decision

Remove comment review from the `commit` tool. Git hooks are the only commit gate. Wrong comments are
left to code and pull request review. Moving comment review to pull request review needs no new
step, because code and PR review can already catch wrong comments. Removing comment review leaves
Git hooks as the only commit gate.

The tool keeps its staging, path, HEAD, and hook-failure rules from
[ADR 0026](./0026-let-git-hooks-own-commit-checks.md). It no longer accepts `commentDispute` or
reports a review. The shared delegate from [ADR 0027](./0027-share-one-delegate-model.md) remains
for bulk reads and web answers.

## Consequences

### Positive

- Agents and users no longer stop on comment wording, and commits make no model call.
- The comment rules live only in the coding instructions, so they cannot drift from a second copy.

### Negative

- Inaccurate comments can land in history until code or pull request review catches them.

## Alternatives considered

### Patch the gate again

Keep the gate and patch it again. Rejected because each retry still gets a fresh review that can
raise a new finding on unchanged code.

### Make every finding advisory

Make every finding advisory. Rejected because each commit still pays for a model call and returns
reports that agents tend to act on.
