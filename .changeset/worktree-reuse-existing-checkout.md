---
'tau': patch
---

The worktree skill now opens a branch that already has a worktree. Grove refuses `grove add` for
such a branch, so the skill takes the checkout path from Grove's refusal and opens that checkout as
a space, instead of reporting a failure and stopping.
