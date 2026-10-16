---
'tau': patch
---

The start-slice skill now updates an existing agent ticket in Linear when a retry changes its body
file. Before, the worker got the new body while Linear and the slice audit kept the old one.
