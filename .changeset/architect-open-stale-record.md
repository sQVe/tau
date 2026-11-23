---
'tau': patch
---

`architect open` now refuses to return a terminal that the saved record ties to a previous lock
generation, so the lead no longer sends its request to an architect that is ending.
