---
'tau': patch
---

`start-slice` no longer drops local edits to an agent ticket's body file when it starts again on a
slice. It restores a missing body file from Linear. When a body file differs from Linear, it asks
which version to keep, and the `start_slice` tool sends a kept local edit to Linear.
