---
'tau': patch
---

A read-only code review no longer starts the posting routine before the user approves changing the
review's scope. The read-only guard in step 8 now decides before every action in that step, and the
posting route claims precedence only over the triage actions.
