---
'tau': patch
---

`start-slice` no longer drops local edits to an agent ticket's body file when it starts again on a
slice. It restores only a missing body file from Linear and keeps one that differs, so the
`start_slice` tool sends the edit to Linear.
