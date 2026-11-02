---
'tau': patch
---

`full_check` and `mutation_check` now share one recorded-check operation that reads the repository,
reuses a passing record, takes the repository lock, runs the command, and saves the record, so each
tool keeps only its own configuration, request validation, and verdict. When the origin remote names
no owner/name repository, `mutation_check` now reports the same error as `full_check`: "This
checkout has an origin remote that does not name an owner/name repository, so the mutation check has
no lock to share with other checkouts of the repository."
