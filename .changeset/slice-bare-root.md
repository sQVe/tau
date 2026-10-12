---
'tau': patch
---

The `slice` tool now works in a bare repository root, as `handover` does. `prepare` creates the
draft in `<root>/.tau/slices/<id>`, and `read` and `apply` accept that directory.
