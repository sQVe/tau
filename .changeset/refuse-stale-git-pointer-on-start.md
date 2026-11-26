---
'tau': patch
---

A Pi start now refuses a folder whose `.git` pointer names a missing path, with
`start folder is not a Git checkout`. The guard asks Git instead of trusting the `.git` entry, so a
bare repository and a linked worktree still start.
