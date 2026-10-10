---
'tau': patch
---

`slice` `read` no longer lists description updates when Linear saved a body's `- ` list items as
`* `. List markers inside fenced code blocks still count as a change. After its writes, `slice`
`apply` reads the container again and moves an open slice back into plan order when Linear left it
out of order. The confirm lists this repair, and `orderInPlace` comes from a fresh read.
