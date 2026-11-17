---
'tau': patch
---

`mutation_check` reads `totals.timeout` from the mutation report and prints a line when mutants
timed out, because Stryker counts a timed-out mutant as killed and an overloaded machine hides
survivors.
