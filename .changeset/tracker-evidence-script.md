---
'tau': patch
---

`tracker` gathers duplicate candidates, parent routing, and label IDs with one read-only `codemode`
script that calls the new `tracker_evidence` tool once per planned ticket. It offers reuse only for
a candidate that fits, and it shows a failed search in the preview instead of reporting no
duplicate.
