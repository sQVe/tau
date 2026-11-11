---
'tau': patch
---

`run_tests` with the Vitest runner reports test results when the project's Vitest config gives its
`json` reporter its own `outputFile`. Tau now writes its report through its own reporter, and the
project's report file is still written.
