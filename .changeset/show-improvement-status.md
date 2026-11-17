---
'tau': patch
---

The footer now shows extension statuses on a second line. The improvement status appears there:
merged tasks to review, `correct due`, and `sweep incomplete` after a failed sweep. It refreshes at
session start, after the sweep, and after a correction is recorded. The `improvement` tool has a new
`status` action that returns the same facts with coverage counts.
