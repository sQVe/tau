---
'tau': patch
---

Start-slice and handover prepare their scratch directories through tested tools instead of shell
instructions. They refuse linked paths that could change files outside the checkout. Handover also
supports preparation from a bare repository root.
