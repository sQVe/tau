---
'tau': patch
---

The `pr` tool has a read-only `coverage` action. It checks whether a chain of saved code reviews,
with their fix captures, covers the diff from the merge base to HEAD. `evidence` reports the same
result as `coverage` when it gets a `chain`.
