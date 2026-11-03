---
'tau': minor
---

The manager now enforces each worker's deadline. About 90 seconds before it, the manager sends the
worker a warning to call `subagent_report` now. At the deadline, the manager ends a worker that is
still running and has not reported, and shows one "ended at its deadline" message. A missing or
malformed assignment file ends its worker at once. A wrong `tau.deadline` label is shown as an
error, and the assignment deadline still applies.
