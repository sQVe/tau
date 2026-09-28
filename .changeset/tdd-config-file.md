---
'tau': minor
---

Read advisory TDD config from a `tdd` block in `~/.pi/agent/tau.json`, overridden by a trusted
repository's `.pi/tau.json`. It can set `productionGlobs`, `testGlobs`, `testSupportGlobs`,
`excludedGlobs`, and `verificationArgv`. Each set field replaces the earlier value, and missing
files keep the defaults. A malformed file pauses hints with an error that names the file and field,
and `run_tests` fails instead of falling back. Edits and commit checks are never blocked. Each
`run_tests` result shows every effective value and where it came from.
