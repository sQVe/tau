---
'tau': minor
---

The `tdd` and `pr` skills run `mutation_check` after the full check when the repository sets
`mutation.argv` in `.pi/tau.json`. Agents handle each surviving mutant in order: a test that kills a
real gap, then simpler code, then a `// Stryker disable next-line <mutator>: <reason>` comment only
for a true equivalent mutant. `triage-findings` uses the same order. The `pr` skill does not publish
while the mutation check fails. Workers that load `tdd` or `pr` get the `mutation_check` tool.
