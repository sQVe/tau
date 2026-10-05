# Review report

Use this shape for the files in the review directory and for the reply to the user.

## Saved files

- Save each worker report in `$dir`: `reviewer.md`, or `finder.md` and `checker.md`.
- Write `$dir/report.md` with the base and HEAD SHAs, the capture `hash`, the source of any check
  result, every finding in full, and refuted candidates with the checker's reason.

## Reply

- Header: the target, mode, elapsed time when you observed it, freshness (fresh, stale, or unknown),
  and a link to `$dir/report.md`. State once how findings were checked: fast has one self-checking
  reviewer, so no finding is independently checked; deep has a finder and a fresh checker.
- Findings: one table, most severe first, with the columns `#`, `Problem and impact`, `Evidence`,
  and `Recommendation`. Keep cells short. Put longer `file:line` evidence and fix directions in
  numbered notes after the table.
  - Evidence: the actual `file:line` and the decisive fact, such as a caller, guard, test, or
    reproduction. In deep mode, add the status: supported, disputed (the checker refuted it but it
    stays plausible), uncertain, or checker-new (not independently checked).
  - Recommendation: fix, investigate, or defer, with a reason drawn from the evidence and the cost
    of acting. Add a bounded fix direction or the question to investigate. A real issue does not
    always need a fix.
- Status says how a finding was checked, not how strong its evidence is. Decisive evidence, such as
  a reproduction, can justify a fix for a checker-new finding. Do not rank confidence or give
  scores. Your agreement does not change a status. If you read source to reach a recommendation, say
  what you read.
- Do not redo the review. Keep every material plausible or disputed finding in the table. Remove
  only exact duplicates and style points no rule supports, and name each in one line. Show refuted
  candidates only when one affects a decision. The checker's verdict is advice, not proof.
- Gaps: after the table, list every gap from the capture (exclusions, binary files, unreadable files
  and directories, submodules, and named paths that list no file), areas workers say they left
  unread, worker failures, stale or unknown freshness, and a check result that may not match the
  capture. Do not infer read coverage from citations.
- Notes: after the gaps, list areas workers say they read only shallowly. They are not gaps.
- With no findings from a complete, fresh run, show no table. Say the workers found no material
  issues in the target. That covers the scope they read; it does not prove the change correct.
