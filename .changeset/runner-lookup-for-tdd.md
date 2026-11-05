---
'tau': patch
---

The TDD runner sits behind a runner object and a static lookup. The Vitest runner owns its defaults,
configuration globs, timeouts, and test-name format, and `defaultSpawn` starts any executable.

Diagnostics record the report path and format of each run, and one record per stage of the run. The
TDD status renders each config value by its type.
