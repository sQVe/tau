---
'tau': patch
---

`full_check` and `mutation_check` now share one recorded-check operation that reads the repository,
reuses a passing record, takes the repository lock, runs the command, and saves the record, so each
tool keeps only its own configuration, request validation, and verdict.
