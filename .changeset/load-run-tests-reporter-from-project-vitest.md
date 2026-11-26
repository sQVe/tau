---
'tau': patch
---

Load the JSON reporter for `run_tests` from the project's own Vitest, so a project that pins a
release without the `vitest/reporters` entry, such as Vitest 5, records its RED and GREEN
observations instead of failing to load Tau's reporter.
