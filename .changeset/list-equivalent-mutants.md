---
'tau': minor
---

The `tdd` and `triage-findings` skills no longer tell agents to add `// Stryker disable` comments.
When no test or simpler code applies, a surviving mutant is equivalent: the code stays as it is, and
the report lists the mutant with its reason. `tdd` stops rerunning `mutation_check` once every
remaining survivor is listed that way. The `pr` skill adds that reason to the survivor's line.
