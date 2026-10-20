---
'tau': patch
---

`draft_review` no longer writes outside the reviewed `.tau/` files. It refuses a hard-linked file,
and `collect` refuses a missing original copy or a saved path outside the reviewed files before it
deletes a comment or writes a file. It rechecks each real file right before its write-back. In
herdr, a review whose terminal moves to another tab or workspace keeps waiting until tuicr ends.
