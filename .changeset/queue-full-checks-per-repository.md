---
'tau': patch
---

`full_check` now queues checks per repository instead of on the whole machine. A check no longer
waits for a check of another repository. Checks of one repository, in different checkouts, still run
one at a time. Pi sessions started before this update keep the old machine-wide lock until they
restart.
