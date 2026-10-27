---
'tau': patch
---

`run_tests` reports input freshness as `unknown`, with the path in the error, when it cannot read a
directory or a symlinked directory among its inputs. It used to skip the directory and report
`fresh`.
