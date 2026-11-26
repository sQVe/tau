---
'tau': patch
---

Take the SIGTERM grace of a stopped check or verification command from the caller, and let the
process-group tests bound it. A command that ignores SIGTERM now escalates to SIGKILL inside a wait
the caller chooses, instead of running into the test budget. The real Vitest runs in the focused
runner test get a budget for one process start.
