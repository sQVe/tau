---
'tau': minor
---

`code-review` gathers its evidence with one read-only `codemode` script after the capture. The
script calls `code_review` with `evidence`, adds bounded rule excerpts, and the manager saves the
result as `evidence.md` in the review directory. Reviewers read it with the full `input.md`. They
and the checker cite only source, lines, and results that the capture, the evidence, or their own
script returned. The report lists every evidence gap with the capture gaps.
