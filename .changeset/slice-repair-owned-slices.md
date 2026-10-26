---
'tau': patch
---

`slice` `apply` repairs the sort order only of slices the Linear viewer owns: the ones assigned to
the viewer, or unassigned ones the viewer created. When a repair would move another person's slice,
apply skips it and returns `orderInPlace: false`.
