# ADR 0091: Return review evidence from the code_review tool

- Status: Accepted
- Date: 2026-10-05
- Supersedes: the scope "capture and freshness mechanics" in
  [ADR 0089](./0089-capture-review-targets-with-a-code-review-tool.md)

## Context

- Reviewers need more than the capture: the tests of the changed code, its callers, and the rule and
  check files the review input names.
- Reviewer workers cannot call `code_review`. The manager gathers this evidence and passes it on.
- Each manager gathered it with its own script. Such a script can read the working tree for a commit
  target, or drop a file it cannot read without saying so.
- PR publication needs the same evidence for a saved capture.

## Options considered

- Keep evidence gathering in each manager's codemode script. Rejected: the reads are untested, and
  each script can read the wrong revision or drop files silently.
- Add a separate evidence tool. Rejected: it would read the same capture record and repeat the
  freshness check, so two tools would own one review directory.
- Add a read-only `evidence` action to `code_review`. Chosen: it reuses the capture record, the
  capture, and the freshness check, and tests cover the reads.

## Decision

`code_review` also returns the review evidence for a saved capture, through an `evidence` action.

- The action reads source at the revision the capture pinned. Only a working tree target reads the
  working tree.
- It returns facts and gaps. A stale or incomplete capture, a cut list or body, an unreadable file,
  and a missing named path each show up as a gap, never as a silent omission.
- It makes no review judgment. It does not choose rule excerpts, rank evidence, or give verdicts.
  That stays in the `code-review` skill.
- It writes nothing to the review directory except the freshness recapture.
- The result is one exported JSON shape, so other review consumers reuse it instead of their own
  reads.

## Tradeoffs

- Tests cover which revision the evidence comes from and every gap it reports.
- Managers pass reviewers one bounded, repeatable result.
- Cost: the tool grows, and the result shape becomes a contract its consumers depend on.
- Cost: callers are found by relative import paths only, so package imports and aliased paths do not
  show up as callers.
- Cost: callers are read one line at a time. A string that holds `import('./a.js')`,
  `require('./a.js')`, or a statement such as `; import a from './a.js'` still counts as a caller.

## See also

- [ADR 0087: Gather evidence with codemode](./0087-gather-evidence-with-codemode.md)
- [ADR 0089: Capture review targets with a code_review tool](./0089-capture-review-targets-with-a-code-review-tool.md)
