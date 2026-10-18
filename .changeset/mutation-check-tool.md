---
'tau': minor
---

A `mutation_check` tool runs the mutation script named by `mutation.argv` in the repository's
`.pi/tau.json`. It runs diff-scoped (`changed`) or whole-file (`audit`) mutation testing, shares the
queue of `full_check`, and lists each surviving mutant with its file, line, mutator, and change. A
pass is saved under `.tau/checks/mutation` and reused while the head, base, command, and uncommitted
changes stay the same.
