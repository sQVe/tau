---
'tau': patch
---

`slice` refuses to read or apply when Linear returns more than one page of a container's children,
attachments, or relations. Before, it planned writes from the first page only, so it could create a
slice that already existed on a later page.
