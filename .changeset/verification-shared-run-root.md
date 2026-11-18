---
'tau': patch
---

Verification runs are stored under the shared repository root, so `pr evidence` can read a run made
in a linked worktree. Configuration, command working directories, and tree identity stay on the
checkout, and the launching checkout stops its own run. Register and stop refuse a symlinked `.tau`
or `.tau/verification` folder before they write.
