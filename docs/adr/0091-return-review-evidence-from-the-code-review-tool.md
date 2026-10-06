# ADR 0091: Return review evidence from the code_review tool

**Date**: 2026-10-05\
**Status**: Accepted\
**Supersedes**: the scope "capture and freshness mechanics" in
[ADR 0089 (Capture review targets with a code_review tool)](./0089-capture-review-targets-with-a-code-review-tool.md)\
**Related**:
[ADR 0087 (Gather evidence with codemode)](./0087-gather-evidence-with-codemode.md)

## Context

Reviewers need more than the capture: the tests of the changed code, its callers, and the rule and
check files the review input names. Reviewer workers cannot call `code_review`, so the manager
gathers this evidence and passes it on.

Each manager gathered it with its own script. Such a script can read the working tree for a commit
target, or drop a file it cannot read without saying so. PR publication needs the same evidence for
a saved capture.

## Decision

`code_review` also returns the review evidence for a saved capture, through an `evidence` action. It
reuses the capture record, the capture, and the freshness check, and tests cover the reads.

### Evidence rules

- The action reads source at the revision the capture pinned. Only a working tree target reads the
  working tree.
- It returns facts and gaps. A stale or incomplete capture, a cut list or body, an unreadable file,
  and a missing named path each show up as a gap, never as a silent omission.
- It makes no review judgment. It does not choose rule excerpts, rank evidence, or give verdicts.
  That stays in the `code-review` skill.
- It writes nothing to the review directory except the freshness recapture.
- The result is one exported JSON shape, so other review consumers reuse it instead of their own
  reads.

## Consequences

### Positive

- Tests cover which revision the evidence comes from and every gap it reports.
- Managers pass reviewers one bounded, repeatable result.

### Negative

- The tool grows, and the result shape becomes a contract its consumers depend on.
- Callers are found by relative import paths only, so package imports and aliased paths do not show
  up as callers.
- Callers are read one line at a time. A string that holds `import('./a.js')`, `require('./a.js')`,
  or a statement such as `; import a from './a.js'` still counts as a caller. So does a trailing
  comment without whitespace before its `//`, because a regular expression such as `/\//` can end in
  two slashes.

## Alternatives considered

### Evidence scripts in each manager

Keep evidence gathering in each manager's codemode script. Rejected because the reads are untested,
and each script can read the wrong revision or drop files silently.

### A separate evidence tool

Add a separate evidence tool. Rejected because it would read the same capture record and repeat the
freshness check, so two tools would own one review directory.
