---
'tau': minor
---

`code_review evidence` and `pr evidence` now list each deleted test file in `markers` as
`{path, marker: "deleted test"}` with its old path. A renamed test file gets no marker. Reviewers
see when a change removes tests; nothing blocks.
