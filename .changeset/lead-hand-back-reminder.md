---
'tau': patch
---

Add a deterministic check before a lead turn settles. When the final text asks the user to approve
or do a step, Tau appends one displayed reminder and continues the turn, so the lead can finish the
step its work already settled. A choice question, a plain report, a non-lead session, an errored or
aborted run, and a second hand-back since the last user message still settle. The check makes no
model call.
