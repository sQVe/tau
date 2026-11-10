---
'tau': patch
---

Replace the ticket draft tool with `ticket` actions to prepare drafts, upsert comments by heading,
and cancel tickets after checking their state and linked pull requests. Keep saved comment IDs in
version 3 drafts, while still reading versions 1 and 2. Recheck ticket and comment state after
confirmation before writing.
