---
'tau': patch
---

`subagent_report` takes an optional `onlyParentCanClear` flag. An early incomplete report that sets
it, such as for a server the worker may not restart or an expired login, is accepted on the first
call instead of being refused once. Reports without the flag are still refused once, and time
blockers keep their rule.
