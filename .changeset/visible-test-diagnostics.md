---
'tau': patch
---

Show focused test files and names, or full-suite scope, while `run_tests` runs. Include scope,
duration, file-level failures, and input freshness in the result.

Save bounded console output and the raw Vitest report, including successful runs, for inspection
without rerunning tests. Console output beyond the capture limit no longer stops tests. Report
truncation accurately and save each diagnostic independently.

Record the command at the spawn point and save the selection and before/after input fingerprints.
Show when execution did not start. Store diagnostics in the Pi agent's private `test-runs`
directory. Cleanup keeps up to 32 completed runs for seven days and protects recent unfinished runs.
These files are diagnostics, not reusable verification.
