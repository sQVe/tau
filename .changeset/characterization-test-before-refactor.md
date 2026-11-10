---
'tau': patch
---

The coding instructions now tell every agent to reuse useful coverage, or add a characterization
test or equivalence check, before a refactor, and to check strings, docs, and serialized names on a
rename. The `tdd` skill's failing-test step now applies to behavior changes only. The manager prompt
drops its refactor line, which workers never saw.
