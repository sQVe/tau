---
'tau': minor
---

Keep the reason on worker notices and records. Collapsed status lines now show a startup failure, an
undelivered or uncertain assignment, and a blocked or unknown native state for every live state, as
a short fixed phrase; ctrl+o shows the full reason. `subagent_status` content includes a bounded
`observationIssue`, and a pending question gains `replySaved: true` once its reply is saved.

`subagent`, `subagent_follow_up`, and `subagent_cancel` return the unreadable-evidence object
instead of an error when saved records cannot be read. A corrupt acknowledgement record no longer
makes a saved Pi reply look failed, `subagent_history` no longer lists the calling worker's own task
or its parent task, and a result saved with an old prose delivery value falls back to Pi's default
rendering.
