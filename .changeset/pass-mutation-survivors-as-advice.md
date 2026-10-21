---
'tau': minor
---

`mutation_check` passes a run with survivors and lists them, covered survivors apart from mutants
with no coverage, grouped by file and line. The `tdd` skill runs it once, allows one fix round of at
most 3 behaviors, and lists what is left as open. The `pr` skill no longer runs it. The `Mutation`
CI job passes on survivors and writes them to the job summary.
