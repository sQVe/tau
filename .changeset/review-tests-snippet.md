---
'tau': patch
---

Add a Review tests snippet. It hands the session's new and changed tests to an investigator subagent
that has not seen the conversation. For each test, the subagent names a production change that would
break the behavior and still pass, and flags tests that pin implementation details.
