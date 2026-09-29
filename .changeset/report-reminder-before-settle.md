---
'tau': patch
---

Send a worker's report reminder at Pi's final settle boundary instead of at the end of each run, so
the reminder does not arrive during a retry or compaction and is not sent twice.
