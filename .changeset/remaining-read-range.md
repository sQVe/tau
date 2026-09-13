---
'tau': patch
---

Show the remaining line range in clamped read hints. Suggest `bulk_read` only when more than 400
lines remain; otherwise, give a bounded read with `offset` and `limit`.
