---
'tau': patch
---

Stop `code_review evidence` from writing `recheck.diff`. Only `code_review freshness` writes or
removes that file, and one read-only inspection now serves review evidence.
