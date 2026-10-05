---
'tau': patch
---

The `stack` skill now switches branches, restacks, or syncs only when none of the manager's workers
is running in the worktree, as well as on a clean tree. A branch change under a running worker moved
the files it was editing.
