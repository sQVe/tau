---
'tau': minor
---

`start-slice` creates and updates its agent tickets with the new `start_slice` tool. Its `read`
action plans the writes and reports problems. Its `apply` action makes them and records each
identifier in `start.json` at once, so a retry after a partial failure does not create a ticket
twice. `start.json` replaces `start.md`.
