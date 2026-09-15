---
'tau': patch
---

Stop before restaging when preparation leaves changed output only in its private index. Retain that
output under a recovery ref for inspection, including staged-only deletions and output from failed
or cancelled preparation. Reject failed message checks before comment review, and report reviewer
failures separately from comment findings. Remove the unused preparationAddedFiles result field.
