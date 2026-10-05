---
'tau': patch
---

The worker bash guard keeps a `bash` result's `structuredContent` when it caps the output. A
codemode script in a worker session now gets the full structured result, with `output`, `truncated`,
`full_output_path`, and `exit_code`, instead of the capped text. The model still sees the capped
text, and the guard still saves the full text privately.
