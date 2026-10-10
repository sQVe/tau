---
'tau': minor
---

Add the `fix-bug` skill. It fixes a defect at its root cause, test-first: reproduce with one
command, diagnose with file and line evidence, add a failing regression test, fix, then rerun the
reproduction and the full check. A scout reproduces and diagnoses, and a worker fixes. It stops for
you only when the root cause is uncertain, no reliable reproduction exists, or the fix changes
behavior beyond the bug. Every `worker` now loads the `tdd` skill. The handover skill says that a
handover links to records and is not a record itself.
