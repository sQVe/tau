---
'tau': patch
---

The `improvement` tool's `status` action skips an event file it cannot read and lists it in `gaps`
with its path and reason. The other readable events still produce the status. A failed event read
now counts as correct due instead of nothing due.
