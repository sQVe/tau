---
'tau': minor
---

Deliver worker replies through the task records instead of typing into the worker pane.
`subagent_reply` saves the reply, and the waiting worker reads it, saves its acknowledgement, and
continues. The reply receipt drops `delivery` and `deliveryError`; `workerAcknowledged` and
`subagent_status` with `questionId` still show whether the worker took the reply. A reply saved
after the worker stopped waiting stays unacknowledged.
