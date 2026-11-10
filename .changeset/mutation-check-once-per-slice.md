---
'tau': patch
---

The start-slice skill runs `mutation_check` once after the last worker of a slice, with the slice's
merge base as `base`. A worker on an agent ticket of a slice skips the mutation step of the tdd
skill, so later workers no longer mutate the work of earlier ones again.
