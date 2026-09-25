---
'tau': patch
---

`subagent_status` no longer stops a worker whose saved evidence is unreadable, and launch and
follow-up no longer stop a worker whose status is unreadable right after launch. Use
`subagent_cancel` to stop it. Cancel now works even when the saved cleanup record is corrupt, for a
worker this session still owns. Reading native output no longer refreshes worker identity or saves
records.
