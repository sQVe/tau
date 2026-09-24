---
'tau': minor
---

Record Pi worker activity, selected model, and task-local usage without polling transcripts. Workers
can publish short phase descriptions with `subagent_progress`. These updates do not wake the parent
or extend the task deadline.
