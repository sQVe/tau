---
'tau': patch
---

The handover, worktree, and retrospective skills, the workflow rules, and the `panes` and `demo`
snippets now use `hc` and `herdr-app` instead of the old `herdr` CLI. The worktree skill opens a new
worktree as a herdr-app space, and the handover skill starts Pi in the checkout's space when no Pi
runs there. Skills that launch workers now need an `hc` terminal instead of herdr.
