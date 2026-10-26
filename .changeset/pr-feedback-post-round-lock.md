---
'tau': patch
---

`pr_feedback` `post` locks the round directory and records each write before it sends it, so two
sessions that post the same round no longer send a write twice or drop each other's records.
