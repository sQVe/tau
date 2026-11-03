---
'tau': patch
---

Stop `code_review evidence` and `pr evidence` from writing `recheck.diff`. Only
`code_review freshness` writes or removes that file, and one read-only inspection now serves PR and
review evidence.
