---
'tau': patch
---

The `tdd` hint keeps a tool result's `structuredContent` when it changes its text. A codemode script
that calls `bash` now gets the structured result after a `tdd` hint instead of a plain string. The
worker bash guard still returns a plain string when it caps `bash` output.
