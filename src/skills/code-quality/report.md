# Quality report

Use this shape for the files in `$dir` and for the reply.

## Saved files

- Each worker report: `finder.md` and `checker.md`.
- Repo run: one `report.md` in the run directory lists findings grouped by part, in run order. A
  list of corrections of earlier parts follows the groups. Each part directory keeps `finder.md`,
  `checker.md`, and `checked.md` instead of its own `report.md`.
- `report.md`: with a ticket, it starts with `# Code quality: <ticket>` and keeps a `Comment ID:`
  line once the comment exists. Then the base and HEAD SHAs, the capture `hash`, every finding in
  full, the Defects, and refuted candidates with the checker's reason.

## Reply

- Header: the target, elapsed time when you observed it, freshness (fresh, stale, or unknown), and a
  link to `report.md`. Say once that a fresh checker tested the finder's candidates, or, when the
  checker gave no report, that they are unverified.
- Findings: one table in the priority order of the quality assignment, with the columns `#`, `Kind`,
  `Problem and evidence`, `Sketch`, `Deletes and adds`, `Keeps`, and `Status`. Put long text in
  numbered notes after it.
  - Repo run: one table per part, in run order, then the list of corrections of earlier parts.
  - Kind: `local` or `restructure`, as the quality assignment defines them.
  - Problem and evidence: `major` first for a major finding, then the `file:line` and the decisive
    fact.
  - Status: supported, refuted, or uncertain. It says how the checker tested a finding, not how
    strong it is. Do not rank confidence or give scores. Your agreement does not change a status.
- Do not redo the review. Keep every supported or uncertain finding. Remove only exact duplicates,
  and name each in one line. Show refuted candidates only when one affects a decision.
- Defects: a separate section that lists each defect the workers met, with its `file:line`. Never
  put a defect in the findings table. Point to code-review for a defect review.
- Gaps: list every gap from the capture and the evidence, areas workers left unread, worker
  failures, and stale or unknown freshness. Do not infer read coverage from citations.
- Notes: areas workers read only shallowly. They are not gaps.
- With no findings from a complete, fresh run, show no table. Say the workers found no material
  structure issues in the scope they read. That does not prove the code well structured.
