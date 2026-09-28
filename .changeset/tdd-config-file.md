---
'tau': minor
---

Read advisory TDD config from a `tdd` block in the repository's `tau.json`. It can set
`productionGlobs`, `testGlobs`, `testSupportGlobs`, `excludedGlobs`, and `verificationArgv`. Each
set field replaces its default, and a missing file keeps the defaults. A malformed file pauses hints
with an error that names the file and field, and `run_tests` fails instead of falling back. Edits
and commit checks are never blocked. Each `run_tests` result shows the effective config.
