---
'tau': patch
---

`mutation_check` now fails on a mutation report whose survivor has a missing or non-Boolean
`covered` field, or a line below 1. Before, it listed such a survivor as covered.
