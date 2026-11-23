---
'tau': patch
---

`architect open` now refuses a terminal that the saved record ties to a previous lock generation. It
compares the record's lock token with the live lock holder before reusing the terminal.
