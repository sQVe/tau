---
'tau': minor
---

Add a read-only `pr_feedback` status action for a pull request or stack. It reports blockers and
gaps and recommends the lowest PR that needs attention. Unknown merge states stay unknown. A blocked
PR stays unknown unless an observed merge gate explains the block; optional pending checks, pending
bot reviews, and draft status alone do not explain it.
