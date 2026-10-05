---
'tau': patch
---

The `tdd` hint and the `bulk_read` read hint keep a tool result's `structuredContent` when they
change its text. Codemode scripts that call `write`, `edit`, `bash`, or `read` get the structured
result instead of a plain string.
