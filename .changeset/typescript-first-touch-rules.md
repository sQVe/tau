---
'tau': minor
---

Load TypeScript rules when a manager or worker first reads, edits, or writes TypeScript source.
Require edits and writes to be reconsidered if their model request had not received the rules. Keep
activation across reloads and resume, and add `/typescript-rules` for shell-only work.
