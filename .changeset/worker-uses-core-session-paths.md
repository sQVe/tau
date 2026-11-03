---
'tau': patch
---

A launched worker inherits `XDG_RUNTIME_DIR` and `XDG_STATE_HOME` from its `hc` core instead of the
manager's process environment, so the worker stays in the manager's session. The worker keeps the
rest of the manager's environment, including `HOME` and the other XDG settings.
