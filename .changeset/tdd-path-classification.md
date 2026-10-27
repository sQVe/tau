---
'tau': patch
---

`run_tests` refuses a test file under an excluded TDD directory, such as `generated/` with
`excludedGlobs: ["generated"]`, because freshness checks never hash that directory. An edit through
a symlinked folder that points outside the project now gives the stale-test hint.
