---
'tau': patch
---

A TDD focused run no longer reports pass when its selected test was skipped or todo while another
test passed. A report that counts no failure but holds a failed assertion now reports fail. A
configured `verificationArgv` is rejected when it carries a positional argument, a bare `--`, or a
test name filter, including a negated one, because those compete with the files and names Tau
selects. Only `run` is accepted directly after `vitest`, and a `related` command word is refused
because Tau writes the `related` command itself for the affected scope.
