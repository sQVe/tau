---
'tau': patch
---

`tracker_draft` has a `record` action. It sets one field of a ticket's `draft.json`, keeps the other
fields, and writes a version 2 record. The code-quality, code-review, and tracker skills call it
instead of writing `draft.json` by hand.
