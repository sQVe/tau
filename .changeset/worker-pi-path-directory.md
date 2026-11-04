---
'tau': patch
---

Worker launch now skips a directory named `pi` on `PATH` and uses the next `pi` executable. Before,
the launch failed with a permission error.
