---
'tau': patch
---

The `improvement` tool's `record` action saves a reviewed task's `review`, `backlog`, and `decision`
events in the task's project root, which those calls now take as a required `projectRoot`, not in
the reviewing session's project. The retrospective skill passes the `projectRoot` that `task`
returns, so a review of another project's task reaches that project's status and sweep.
