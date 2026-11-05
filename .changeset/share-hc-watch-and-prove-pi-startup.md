---
'tau': patch
---

Move the running event watch from the subagents extension into a shared `hc` module. The worker
watch becomes a thin adapter with unchanged behavior, and a new startup gate reports when Pi has
finished starting a session.
