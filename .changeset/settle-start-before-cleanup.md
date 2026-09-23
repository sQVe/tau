---
'tau': patch
---

Wait for an in-flight Pi start response within the cleanup budget before checking for worker
absence. Prevent shutdown from freeing a slot while a late start leaves Pi running.
