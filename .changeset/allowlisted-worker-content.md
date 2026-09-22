---
'tau': minor
---

Send subagent tools and notices only the worker fields the model needs. `subagent_status`,
`subagent_follow_up`, and `subagent_cancel` return a named allowlist instead of the full saved
record, while `details` keeps the full object for renderers. `recovery`, `capacityHeld`,
`unconfirmedChildren`, and `descendantEvidence` appear only for `cleanupUnconfirmed` and `notOwned`,
and record directories and native file paths leave the model content.

Notices are now status snapshots taken when sent, delivered as a steer for questions and as a next
turn message otherwise. A notice without `state` means the parent could not read the task records;
inspect its `recovery`. When saved records are unreadable, `subagent_status` now returns that same
shape with `recovery` instead of an error. Submission receipts narrow to `{id, state?, detail?}`, Pi
reply content includes `questionId`, and tool descriptions explain the worker states, reply delivery
values, and follow-up eligibility.
