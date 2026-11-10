---
'tau': patch
---

Let `start_slice read` pick a ready slice from its order, dependencies, and linked pull requests.
Let `start_slice apply` move the slice to In Progress before writing agent tickets. The read lists
the move, and apply asks for confirmation when the viewer does not own the slice.
