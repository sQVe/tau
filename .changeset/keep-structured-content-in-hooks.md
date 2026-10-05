---
'tau': patch
---

The `tdd` hint and the `bulk_read` read hint keep a tool result's `structuredContent` when they
change its text. A codemode script that calls `bash` now gets the structured result after a `tdd`
hint instead of a plain string. The worker bash guard still returns a plain string when it caps
`bash` output.
