---
'tau': patch
---

Roll back a failed `code_review` capture, so a retry works, and write `capture.json` and the draft
review records through a temporary file, so a failed write never leaves a cut-off record.
