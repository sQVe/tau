---
'tau': patch
---

`subagent_status` no longer stops a worker whose saved evidence is unreadable. Use `subagent_cancel`
to stop it, which now works even when the saved cleanup record is corrupt. Reading native output no
longer refreshes worker identity or saves records.
