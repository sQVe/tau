---
'tau': patch
---

Read a slice as merged only when a linked pull request closes it. A pull request that only mentions
the slice no longer hides it from `start_slice` read or from the slice read's merged flag.
