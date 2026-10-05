---
'tau': patch
---

The `stack` skill now switches branches, restacks, or syncs only when every one of the manager's
workers in the worktree has stopped, as well as on a clean tree. `start-slice` checks the same
before it switches to the slice branch. A branch change under a live worker moved the files it was
editing.
