---
'tau': patch
---

`full_check` and `mutation_check` now save a record for a failing run too. The record has a new
version with a `passed` field, and only a passing record is reused. Records saved by earlier
versions are not reused, so the first check on each state runs again.
