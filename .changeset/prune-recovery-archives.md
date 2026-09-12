---
'tau': patch
---

Remove commit recovery snapshots and their Git ref after verified restoration, keeping only the
displaced inodes. Treat checker output matched by the external exclude rules that were in force at
backup time as ignored, so `.git/info/exclude` and `core.excludesFile` artifacts no longer strand
working edits.
