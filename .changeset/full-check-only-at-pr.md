---
'tau': patch
---

Workers no longer get the `full_check` tool. The PR step runs the only full check, and workers run
focused tests and the check stage that failed.
