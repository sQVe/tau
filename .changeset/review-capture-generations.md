---
'tau': patch
---

`code_review` capture publishes a complete generation. It saves the original patch and input under
`capture/` in the review directory, writes `capture.json` last, refuses a directory that another
capture claimed, and returns `identity`, the Git blob hash of `capture.json`.
