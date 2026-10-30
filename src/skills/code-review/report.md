# Review report

Use this shape for the files in `$dir` and for the reply.

## Saved files

- Each worker report: `reviewer.md`, or `finder.md` and `checker.md`.
- `report.md`, the comment body. With a ticket, start it with `# Code review: <ticket>` and keep a
  `Comment ID:` line once the comment exists. Include the target kind, the base and HEAD SHAs, the
  capture `hash`, the capture `identity`, the source of any check result, every finding in full, and
  refuted candidates with the checker's reason.
- For a fix review, also include the predecessor review directory (`target.review` in
  `capture.json`) and its identity (`target.predecessor.identity`). When `capture.json` has no
  `target.predecessor`, as for a fix on a legacy review, write the identity as `unavailable`. Never
  guess it.

## Reply

- Header: the target, mode, elapsed time when you observed it, freshness (fresh, stale, or unknown),
  and a link to `report.md`. Say once how findings were checked: fast has one self-checking
  reviewer; deep adds a fresh checker.
- Findings: one table, most severe first, with the columns `#`, `Problem and impact`, `Evidence`,
  and `Recommendation`. Put long evidence and fix directions in numbered notes after it.
  - Evidence: the `file:line` and the decisive fact, such as a caller, guard, test, or reproduction.
    In deep mode, add the status: supported, disputed (refuted but still plausible), uncertain, or
    checker-new.
  - Recommendation: fix, investigate, or defer, with a reason from the evidence and the cost of
    acting, plus a bounded fix direction or the question to investigate.
- Status says how a finding was checked, not how strong it is. Decisive evidence can justify fixing
  a checker-new finding. Do not rank confidence or give scores. Your agreement does not change a
  status. Say what source you read to reach a recommendation.
- Do not redo the review. Keep every material plausible or disputed finding. Remove only exact
  duplicates and style points no rule supports, and name each in one line. Show refuted candidates
  only when one affects a decision.
- Gaps: list every gap from the capture and the evidence, areas workers left unread, worker
  failures, stale or unknown freshness, and a check result that may not match the capture. Do not
  infer read coverage from citations.
- Notes: areas workers read only shallowly. They are not gaps.
- With no findings from a complete, fresh run, show no table. Say the workers found no material
  issues in the scope they read. That does not prove the change correct.
