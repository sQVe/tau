---
'tau': minor
---

The `start-slice` skill asks once per slice, after the workers report, whether to run
`/code-quality`. On yes it runs the structure review and its triage before `code-review`, which then
reviews the whole slice.
