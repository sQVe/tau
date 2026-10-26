---
'tau': patch
---

The `commit` tool no longer treats a failed HEAD read as an unborn branch. When Git cannot read
HEAD, the tool stops, leaves staging untouched, and reports Git's error. Only a branch with no
commit counts as having no HEAD.
