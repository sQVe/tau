---
'tau': patch
---

Fail worker launches promptly after startup exits instead of waiting for herdr's timeout. Preserve
the worker's failure detail and confirm the shell is bare before cleanup.
