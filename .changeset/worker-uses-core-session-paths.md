---
'tau': patch
---

A launched worker inherits its `hc` core's `HOME` and `XDG_*` paths instead of the manager's process
environment. The worker stays in the manager's session even when the manager's shell paths differ
from the core's.
