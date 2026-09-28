---
'tau': patch
---

Say in the `subagent_reply` description that a Pi reply needs the `questionId` from the worker's
question notice, and that a Pi worker without a pending question takes no reply, so the parent
should use `subagent_follow_up` after the worker stops.
