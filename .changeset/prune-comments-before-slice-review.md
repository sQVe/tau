---
'tau': patch
---

The start-slice skill runs the prune-comments skill after the last worker and the mutation check,
before code-quality and review. The pr skill runs it only on commits added after the review. The
prune-comments skill launches no worker when the diff adds or changes no comment, keeps a comment
that is the only content of a block, and lints the changed files before it commits.
